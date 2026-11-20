// The sign-in board photo import's --apply step (scripts/signin-photos/import.mjs,
// ADR 0010 decision 4) against the throwaway database and MinIO, with tiny generated
// images only (never real photos):
//   - a fake converter: rows, events created as `reported`, one summary audit row, objects
//     in the bucket (a HEIC original stored as image/heic, untouched), and a re-run that
//     imports nothing (idempotent)
//   - the photo folder: symlinks and files over the size cap are refused
//   - the real converter (convert.py) when BOCC_PHOTO_PYTHON points at a Python with
//     Pillow and pillow-heif: a synthetic HEIC and a rotated JPEG, end to end
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_URL, connect } from "./helpers.mjs";
import { getStorage } from "../../src/lib/admin/storage.mjs";
import { AUDIT_ACTION, applyImport, inspectPhotos, listPhotoFiles, pythonConverter } from "../../scripts/signin-photos/import.mjs";
import { importId, matchPhotos, resolvePlan } from "../../scripts/signin-photos/match.mjs";

const skip = process.env.STORAGE_ENDPOINT ? false : "MinIO not running (STORAGE_ENDPOINT unset)";
const PYTHON = process.env.BOCC_PHOTO_PYTHON;

const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAMDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCzRRRXwR9sf//Z", "base64");
const sha = (b) => createHash("sha256").update(b).digest("hex");

let owner;
let dir;
before(async () => {
  owner = await connect(OWNER_URL);
  dir = mkdtempSync(join(tmpdir(), "bocc-import-test-"));
});
after(async () => {
  await owner?.end();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** Writes the three variants as the real converter would: the original untouched. */
const fakeConvert = (src, out) => {
  const bytes = readFileSync(src);
  const heic = src.endsWith(".HEIC");
  const files = {};
  for (const v of ["original", "display", "thumb"]) {
    const p = join(out, `${v}.${v === "original" && heic ? "heic" : "jpg"}`);
    writeFileSync(p, v === "original" ? bytes : Buffer.concat([JPEG, Buffer.from(v)]));
    files[v] = { path: p, contentType: v === "original" && heic ? "image/heic" : "image/jpeg", size: readFileSync(p).length };
  }
  return files;
};

describe("the photo folder is untrusted", () => {
  test("symlinks are refused, not followed", () => {
    const d = mkdtempSync(join(dir, "links-"));
    mkdirSync(join(d, "Signin Sheets"));
    writeFileSync(join(d, "Signin Sheets", "09-10-2024.HEIC"), JPEG);
    symlinkSync("/etc/passwd", join(d, "Signin Sheets", "IMG_0009.HEIC"));
    assert.throws(() => listPhotoFiles(d), /refusing a symlink in the photo folder: IMG_0009\.HEIC/);
  });
  test("files over the 25 MB cap are refused before decoding", () => {
    const d = mkdtempSync(join(dir, "big-"));
    const f = join(d, "IMG_0010.HEIC");
    writeFileSync(f, "");
    truncateSync(f, 25 * 1024 * 1024 + 1); // sparse
    assert.throws(() => inspectPhotos("/nonexistent-python", listPhotoFiles(d)), /over the 26214400 byte cap: IMG_0010\.HEIC/);
  });
});

describe("photo import --apply against MinIO", { skip }, () => {
  test("uploads, inserts ready signin_board rows, creates reported events, one audit row; a re-run does nothing", async () => {
    // Unique bytes per run, so the derived ids are new even on a reused database.
    const salt = `${Date.now()}-${Math.random()}`;
    const photos = [
      { name: "02-05-2019.HEIC", date: "2019-02-05", bytes: Buffer.concat([JPEG, Buffer.from(`a${salt}`)]) },
      { name: "IMG_0001.HEIC", date: null, bytes: Buffer.concat([JPEG, Buffer.from(`b${salt}`)]) },
      { name: "IMG_0002.JPG", date: null, bytes: Buffer.concat([JPEG, Buffer.from(`c${salt}`)]) },
    ];
    const paths = new Map(photos.map((p) => { const f = join(dir, p.name); writeFileSync(f, p.bytes); return [p.name, f]; }));
    // 2019-02-12 already exists as `scheduled`; 2019-02-05 doesn't exist yet.
    await owner.query("delete from event_media where event_date in ('2019-02-05', '2019-02-12')");
    await owner.query("delete from events where event_date in ('2019-02-05', '2019-02-12')");
    await owner.query("insert into events (event_date) values ('2019-02-12')");

    const rows = matchPhotos([
      { name: photos[0].name, sha256: sha(photos[0].bytes), capture: "2019-02-05T08:30:00" },
      { name: photos[1].name, sha256: sha(photos[1].bytes), capture: "2019-02-14T08:30:00" },
      { name: photos[2].name, sha256: sha(photos[2].bytes), capture: null },
    ], { eventDates: ["2019-02-12"] });
    assert.deepEqual(rows.map((r) => [r.matched, r.uncertain]), [["2019-02-05", true], ["2019-02-12", false], [null, true]]);
    assert.throws(() => resolvePlan(rows, new Map()), /uncertain and not confirmed/);
    const resolved = resolvePlan(rows, new Map([
      ["02-05-2019.HEIC", "2019-02-05"], ["IMG_0001.HEIC", "2019-02-12"], ["IMG_0002.JPG", "skip"],
    ]));

    const workDir = mkdtempSync(join(dir, "work-"));
    const storage = getStorage().storage;
    const logs = [];
    const result = await applyImport({ client: owner, storage, resolved, paths, convert: fakeConvert, workDir, log: (m) => logs.push(m) });
    assert.deepEqual(result.imported, ["02-05-2019.HEIC", "IMG_0001.HEIC"]);
    assert.deepEqual(result.skipped, ["IMG_0002.JPG"]);
    assert.deepEqual(result.eventsCreated, ["2019-02-05"]);

    const { rows: ev } = await owner.query(
      "select event_date::text as d, status from events where event_date in ('2019-02-05', '2019-02-12') order by 1");
    assert.deepEqual(ev, [{ d: "2019-02-05", status: "reported" }, { d: "2019-02-12", status: "scheduled" }], "existing events untouched");

    const ids = [importId(sha(photos[0].bytes)), importId(sha(photos[1].bytes))];
    const { rows: media } = await owner.query(
      `select id::text, event_date::text as d, kind, publicly_usable, status, uploaded_by, content_type, size_bytes::int as size,
              original_key, display_key, thumb_key
         from event_media where id = any($1::uuid[]) order by event_date`, [ids]);
    assert.equal(media.length, 2);
    for (const m of media) {
      assert.deepEqual([m.kind, m.publicly_usable, m.status, m.uploaded_by, m.content_type], ["signin_board", false, "ready", null, "image/heic"]);
      assert.equal(m.original_key, `events/${m.d}/${m.id}/original.heic`);
      assert.equal(m.display_key, `events/${m.d}/${m.id}/display.jpg`);
      for (const k of [m.original_key, m.display_key, m.thumb_key]) assert.ok(await storage.headObject({ key: k }), k);
    }
    const original = await fetch(storage.presignGet({ key: media[0].original_key }).url);
    assert.equal(original.headers.get("content-type"), "image/heic");
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), photos[0].bytes, "original stored as given");

    const { rows: audit } = await owner.query(
      "select actor_user_id, details from audit_log where action = $1 and details->'imported'->0->>'id' = $2", [AUDIT_ACTION, ids[0]]);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_user_id, null);
    assert.deepEqual(audit[0].details.imported.map((i) => [i.file, i.sha256, i.eventDate]),
      [["02-05-2019.HEIC", sha(photos[0].bytes), "2019-02-05"], ["IMG_0001.HEIC", sha(photos[1].bytes), "2019-02-12"]]);

    // Re-run: nothing new, no new audit row.
    const { rows: [{ n: before }] } = await owner.query("select count(*)::int as n from audit_log where action = $1", [AUDIT_ACTION]);
    const again = await applyImport({ client: owner, storage, resolved, paths, convert: () => assert.fail("must not convert"), workDir: mkdtempSync(join(dir, "work-")), log: () => {} });
    assert.deepEqual([again.imported, again.already], [[], ["02-05-2019.HEIC", "IMG_0001.HEIC"]]);
    const { rows: [{ n: afterN }] } = await owner.query("select count(*)::int as n from audit_log where action = $1", [AUDIT_ACTION]);
    assert.equal(afterN, before);
  });
});

describe("photo import with the real converter", { skip: skip || (PYTHON ? false : "BOCC_PHOTO_PYTHON not set") }, () => {
  test("synthetic HEIC and rotated JPEG: capture dates read, copies resized and stripped", async () => {
    const src = mkdtempSync(join(dir, "src-"));
    // A 2000x1000 HEIC with a capture date, and a 1000x600 JPEG with Orientation 6
    // (rotate 90) and a GPS tag. Generated here; no real photos.
    const gen = spawnSync(PYTHON, ["-I", "-c", `
import sys, pillow_heif
from PIL import Image
pillow_heif.register_heif_opener()
d = sys.argv[1]
ex = Image.Exif(); ex.get_ifd(0x8769)[36867] = "2025:03:04 08:45:00"
Image.new("RGB", (2000, 1000), (10, 120, 200)).save(d + "/03-04-2025.HEIC", exif=ex.tobytes())
ex2 = Image.Exif(); ex2[274] = 6; ex2.get_ifd(0x8769)[36867] = "2025:03:11 09:00:00"; ex2.get_ifd(0x8825)[1] = "N"
Image.new("RGB", (1000, 600), (200, 50, 50)).save(d + "/IMG_0003.JPG", exif=ex2.tobytes(), quality=90)
ex3 = Image.Exif(); ex3.get_ifd(0x8769)[36867] = "2025:03:18 08:40:00"
Image.new("RGB", (800, 600), (0, 0, 0)).save(d + "/IMG_0004.JPG", "MPO", save_all=True,
    append_images=[Image.new("RGB", (800, 600), (9, 9, 9))], exif=ex3.tobytes())
`, src], { encoding: "utf8" });
    assert.equal(gen.status, 0, gen.stderr);

    const files = listPhotoFiles(src);
    const info = inspectPhotos(PYTHON, files);
    assert.deepEqual(info.map((p) => [p.name, p.capture, p.format]), [
      ["03-04-2025.HEIC", "2025-03-04T08:45:00", "HEIF"], ["IMG_0003.JPG", "2025-03-11T09:00:00", "JPEG"],
      ["IMG_0004.JPG", "2025-03-18T08:40:00", "MPO"],
    ]);

    const convert = pythonConverter(PYTHON);
    const out1 = mkdtempSync(join(dir, "c1-"));
    const heic = convert(files[0], out1);
    assert.equal(heic.original.contentType, "image/heic", "HEIC archived as itself");
    assert.match(heic.original.path, /original\.heic$/);
    assert.deepEqual(readFileSync(heic.original.path), readFileSync(files[0]), "HEIC original byte for byte");
    assert.deepEqual([heic.display.width, heic.display.height, heic.thumb.width, heic.thumb.height], [1600, 800, 400, 200]);
    const out2 = mkdtempSync(join(dir, "c2-"));
    const jpg = convert(files[1], out2);
    assert.deepEqual(readFileSync(jpg.original.path), readFileSync(files[1]), "a JPEG original is byte for byte");
    assert.deepEqual([jpg.display.width, jpg.display.height], [600, 1000], "rotated upright, not upscaled");
    assert.deepEqual([jpg.thumb.width, jpg.thumb.height], [240, 400]);

    const mpo = convert(files[2], mkdtempSync(join(dir, "c3-")));
    assert.equal(mpo.original.contentType, "image/jpeg", "Pillow's MPO is a JPEG");
    assert.match(mpo.original.path, /original\.jpg$/);
    assert.deepEqual([mpo.display.width, mpo.display.height], [800, 600]);

    // Decompression bombs: over 120 MP is refused (Pillow only warns up to 240 MP).
    const bombDir = mkdtempSync(join(dir, "bomb-"));
    const bomb = spawnSync(PYTHON, ["-I", "-c",
      "import sys; from PIL import Image; Image.MAX_IMAGE_PIXELS=None; Image.new('1', (11000, 11000)).save(sys.argv[1] + '/IMG_0005.PNG')",
      bombDir], { encoding: "utf8" });
    assert.equal(bomb.status, 0, bomb.stderr);
    assert.throws(() => inspectPhotos(PYTHON, listPhotoFiles(bombDir)), /DecompressionBomb/);

    // The copies carry no metadata at all.
    const meta = spawnSync(PYTHON, ["-I", "-c", `
import sys
from PIL import Image
for p in sys.argv[1:]:
    im = Image.open(p)
    print(len(im.getexif()), "icc_profile" in im.info, "exif" in im.info)
`, jpg.display.path, jpg.thumb.path, heic.display.path], { encoding: "utf8" });
    assert.equal(meta.status, 0, meta.stderr);
    assert.deepEqual(meta.stdout.trim().split("\n"), ["0 False False", "0 False False", "0 False False"]);
  });
});
