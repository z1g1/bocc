#!/usr/bin/env node
// One-time import of the old sign-in board photos (ADR 0010 decision 4, amended
// 2026-11-17). Runs on an operator's machine, never on the server. HEIC is decoded
// locally by convert.py (Pillow + pillow-heif in a venv outside the repo).
//
// 1. Dry run (the default; no writes anywhere): prints the match table.
//      node --env-file=.env.local scripts/signin-photos/import.mjs \
//        --photos <extracted dir> --python <venv>/bin/python
//    Event dates are read (SELECT only) from DATABASE_URL, the owner URL in .env.local.
//    --no-db skips that (every row is then flagged "events not checked");
//    --events-file <file> (one YYYY-MM-DD per line) stands in for the database in a
//    dry run, e.g. before the Google Form import has created the events rows.
//
// 2. Zack confirms the uncertain rows (marked "?") in an override file, one per line:
//      IMG_2892.JPG,2026-09-08        # this date (may be the matched one: confirms it)
//      11-06-2024.HEIC,skip           # leave this photo out
//
// 3. Apply (writes): uploads three objects per photo through storage.mjs presignPut,
//    (the original is the untouched file: HEIC stays HEIC, image/heic, which migration
//    20261119120000 allows for signin_board only; display and thumbnail are JPEGs),
//    then, in ONE transaction as the owner, creates missing events rows as `scheduled`
//    (a photo is no Event Report, so the date shows "Report missing" until one is in),
//    inserts the event_media rows (kind signin_board, never publicly_usable, status
//    ready, uploaded_by NULL) and one summary audit_log row.
//      node --env-file=.env.local --env-file=<storage env> scripts/signin-photos/import.mjs \
//        --photos <dir> --python <venv>/bin/python --apply --confirm <override file> \
//        --work-dir <new empty dir outside the repo>
//    Every uncertain row must be listed in the override file, or nothing is written.
//    --confirm WITHOUT --apply is still a dry run: it checks the file and prints what
//    --apply would do.
//
// Idempotent without a schema change: each photo's event_media id is derived from the
// SHA-256 of its source file (match.mjs importId), so its object keys are fixed too. A
// re-run skips ids already in event_media and re-uploading a half-finished photo just
// overwrites the same keys. (A photo deleted in the admin would be imported again by
// a re-run; the summary audit row lists every file, hash and id.)

import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { formatTable, importId, matchPhotos, parseOverrides, resolvePlan } from "./match.mjs";
import { createStorage, extForContentType, mediaKey, readStorageEnv } from "../../src/lib/admin/storage.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONVERTER = join(HERE, "convert.py");
export const AUDIT_ACTION = "media.import_signin_photos";

/**
 * Size caps for what the import uploads: the same as the browser path's
 * (src/lib/admin/media.mjs LIMITS). The real originals are 0.1–3.2 MB.
 */
export const IMPORT_LIMITS = Object.freeze({ original: 25 * 1024 * 1024, display: 5 * 1024 * 1024, thumb: 1024 * 1024 });

/** Regular, non-hidden files under `dir` (the Drive export has one sub-folder); symlinks refused. */
export function listPhotoFiles(dir) {
  const out = [];
  const walk = (d, depth) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith(".") || name === "__MACOSX") continue;
      const p = join(d, name);
      // lstat: never follow a symlink out of the (untrusted) extracted folder.
      const st = lstatSync(p);
      if (st.isSymbolicLink()) throw new Error(`refusing a symlink in the photo folder: ${name}`);
      if (st.isDirectory() && depth < 2) walk(p, depth + 1);
      else if (st.isFile()) out.push(p);
    }
  };
  walk(resolve(dir), 0);
  const names = out.map((p) => basename(p));
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length) throw new Error(`two files share a name: ${[...new Set(dupes)].join(", ")}`);
  return out;
}

function runPython(python, args) {
  // -I: isolated mode (no cwd / script dir / user site on sys.path, no PYTHON* env),
  // and cwd is this script's folder, never the untrusted photo folder.
  const r = spawnSync(python, ["-I", CONVERTER, ...args], { cwd: HERE, encoding: "utf8", maxBuffer: 16 << 20 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`convert.py ${args[0]} failed (exit ${r.status}): ${r.stderr.trim().split("\n").at(-1)}`);
  return r.stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** EXIF capture date and hash for each file. Files over the original cap are refused. */
export function inspectPhotos(python, files) {
  const big = files.filter((f) => lstatSync(f).size > IMPORT_LIMITS.original).map((f) => basename(f));
  if (big.length) throw new Error(`over the ${IMPORT_LIMITS.original} byte cap: ${big.join(", ")}`);
  const info = runPython(python, ["inspect", ...files]);
  return info.map((p, i) => ({ ...p, path: files[i] }));
}

/** Convert one photo into `outdir`: { original, display, thumb } each { path, contentType, size }. */
export const pythonConverter = (python) => (src, outdir) => runPython(python, ["convert", src, outdir])[0];

export async function loadEventDates(client) {
  const { rows } = await client.query("select event_date::text as d from public.events order by 1");
  return rows.map((r) => r.d);
}

/**
 * Upload and insert the planned photos. Objects first (re-runs overwrite the same
 * keys), then all rows plus one audit row in ONE transaction.
 * @param {object} o
 * @param {import("pg").ClientBase} o.client         owner connection
 * @param {ReturnType<typeof createStorage>} o.storage
 * @param {ReturnType<typeof resolvePlan>} o.resolved
 * @param {Map<string, string>} o.paths              file name -> source path
 * @param {(src: string, outdir: string) => any} o.convert
 * @param {string} o.workDir                         empty directory for the converted files
 * @param {(msg: string) => void} [o.log]
 */
export async function applyImport({ client, storage, resolved, paths, convert, workDir, log = console.log }) {
  const items = resolved.plan.map((p) => ({ ...p, id: importId(p.sha256) }));
  const { rows: existing } = await client.query(
    "select id::text from public.event_media where id = any($1::uuid[])", [items.map((i) => i.id)]);
  const done = new Set(existing.map((r) => r.id));
  const todo = items.filter((i) => !done.has(i.id));
  const already = items.filter((i) => done.has(i.id)).map((i) => i.name);
  if (already.length) log(`already imported, skipped: ${already.join(", ")}`);

  const uploaded = [];
  for (const [n, item] of todo.entries()) {
    log(`(${n + 1}/${todo.length}) ${item.name} -> ${item.date}`);
    const out = join(workDir, item.id);
    mkdirSync(out, { recursive: false });
    const files = convert(paths.get(item.name), out);
    const ext = extForContentType(files.original.contentType);
    if (!["jpg", "png", "heic", "heif"].includes(ext)) throw new Error(`${item.name}: unexpected original type ${files.original.contentType}`);
    for (const v of ["original", "display", "thumb"]) {
      if (!(files[v].size > 0 && files[v].size <= IMPORT_LIMITS[v])) throw new Error(`${item.name}: ${v} is ${files[v].size} bytes, over the cap`);
      if (v !== "original" && files[v].contentType !== "image/jpeg") throw new Error(`${item.name}: ${v} must be a JPEG`);
    }
    const keys = {
      original: mediaKey(item.date, item.id, "original", ext),
      display: mediaKey(item.date, item.id, "display", "jpg"),
      thumb: mediaKey(item.date, item.id, "thumb", "jpg"),
    };
    for (const variant of ["thumb", "display", "original"]) {
      const f = files[variant];
      const body = readFileSync(f.path);
      const put = storage.presignPut({ key: keys[variant], contentType: f.contentType, contentLength: body.length });
      const res = await fetch(put.url, { method: "PUT", headers: put.headers, body });
      await res.body?.cancel();
      if (!res.ok) throw new Error(`upload of ${item.name} ${variant} failed with ${res.status}`);
      const head = await storage.headObject({ key: keys[variant] });
      if (!head || head.contentLength !== body.length) throw new Error(`upload of ${item.name} ${variant} did not verify`);
    }
    uploaded.push({ ...item, keys, contentType: files.original.contentType, size: files.original.size });
  }

  if (uploaded.length === 0) {
    log("nothing new to import");
    return { imported: [], already, skipped: resolved.skipped, eventsCreated: [] };
  }

  await client.query("begin");
  try {
    const eventsCreated = [];
    for (const date of [...new Set(uploaded.map((u) => u.date))].sort()) {
      const r = await client.query(
        "insert into public.events (event_date, status) values ($1, 'scheduled') on conflict (event_date) do nothing", [date]);
      if (r.rowCount === 1) eventsCreated.push(date);
    }
    for (const u of uploaded) {
      await client.query(
        `insert into public.event_media
           (id, event_date, kind, original_key, display_key, thumb_key, content_type, size_bytes,
            publicly_usable, status, uploaded_by)
         values ($1, $2, 'signin_board', $3, $4, $5, $6, $7, false, 'ready', null)
         on conflict (id) do nothing`,
        [u.id, u.date, u.keys.original, u.keys.display, u.keys.thumb, u.contentType, u.size]);
    }
    await client.query(
      `insert into public.audit_log (actor_user_id, action, target_table, target_id, details)
       values (null, $1, 'event_media', null, $2)`,
      [AUDIT_ACTION, JSON.stringify({
        imported: uploaded.map((u) => ({ file: u.name, sha256: u.sha256, id: u.id, eventDate: u.date, overridden: u.overridden })),
        alreadyImported: already,
        skipped: resolved.skipped,
        eventsCreated,
      })]);
    await client.query("commit");
    return { imported: uploaded.map((u) => u.name), already, skipped: resolved.skipped, eventsCreated };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}

async function main() {
  const { values: a } = parseArgs({
    options: {
      photos: { type: "string" },
      python: { type: "string", default: "python3" },
      "no-db": { type: "boolean", default: false },
      "events-file": { type: "string" },
      apply: { type: "boolean", default: false },
      confirm: { type: "string" },
      "work-dir": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (a.help || !a.photos) {
    console.log("usage: import.mjs --photos <dir> [--python <venv python>] [--no-db | --events-file <file>]\n" +
      "       import.mjs --photos <dir> --python <p> --apply --confirm <override file> --work-dir <empty dir>");
    process.exit(a.help ? 0 : 2);
  }
  if (a.apply && (!a.confirm || !a["work-dir"])) throw new Error("--apply needs --confirm <file> and --work-dir <dir>");
  if (a.apply && (a["no-db"] || a["events-file"])) throw new Error("--apply reads events from the database only");
  if (a["events-file"]) a["no-db"] = true;

  const files = listPhotoFiles(a.photos);
  const photos = inspectPhotos(a.python, files);

  let client = null;
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!a["no-db"]) {
    if (!url) throw new Error("DATABASE_URL is not set (owner URL from .env.local), or pass --no-db for a dry run");
    const { Client } = (await import("pg")).default;
    const { toPgConfig } = createRequire(import.meta.url)("../../backend/netlify/functions/utils/db-ssl.js");
    client = new Client(toPgConfig(url));
    await client.connect();
  }
  try {
    const eventDates = client ? await loadEventDates(client)
      : a["events-file"] ? readFileSync(a["events-file"], "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      : null;
    const rows = matchPhotos(photos, { eventDates });
    console.log(formatTable(rows));
    const unsure = rows.filter((r) => r.uncertain).length;
    console.log(`\n${rows.length} photos, ${unsure} uncertain (marked ?)${eventDates ? `; ${eventDates.length} known events (${client ? "database" : a["events-file"]})` : "; events NOT checked (--no-db)"}`);
    if (!a.apply && !a.confirm) {
      console.log("Dry run: nothing was written.");
      return;
    }

    const resolved = resolvePlan(rows, parseOverrides(readFileSync(a.confirm, "utf8")));
    if (!a.apply) {
      // Dry run WITH the confirm file: show exactly what --apply would do.
      const known = new Set(eventDates ?? []);
      const newEvents = [...new Set(resolved.plan.map((p) => p.date))].filter((d) => !known.has(d)).sort();
      console.log(`\nWith ${a.confirm}: every uncertain row is confirmed. --apply would import ${resolved.plan.length}` +
        ` (${resolved.plan.filter((p) => p.overridden).length} with a changed date), skip ${resolved.skipped.length},` +
        ` and create ${newEvents.length} events as scheduled${newEvents.length ? `: ${newEvents.join(", ")}` : ""}.`);
      for (const p of resolved.plan.filter((x) => x.overridden)) console.log(`  ${p.name} -> ${p.date}`);
      console.log("Dry run: nothing was written.");
      return;
    }
    const s = readStorageEnv();
    if (!s.enabled) throw new Error(s.message);
    const workDir = resolve(a["work-dir"]);
    if (readdirSync(workDir).length) throw new Error("--work-dir must be empty");
    const result = await applyImport({
      client, storage: createStorage(s.config), resolved,
      paths: new Map(photos.map((p) => [p.name, p.path])),
      convert: pythonConverter(a.python), workDir,
    });
    console.log(`imported ${result.imported.length}, already there ${result.already.length}, skipped ${result.skipped.length}; ` +
      `events created (scheduled): ${result.eventsCreated.join(", ") || "none"}`);
  } finally {
    await client?.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(String(err?.message ?? err).replace(/postgres(ql)?:\/\/\S+/gi, "<redacted-url>"));
    process.exit(1);
  });
}
