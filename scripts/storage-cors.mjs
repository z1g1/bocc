#!/usr/bin/env node
// Operator tool for the media bucket (ADR 0010; docs/backend/NEON_PERMISSIONS.md
// "Storage"). Reads the same STORAGE_* variables as the app (src/lib/admin/storage.mjs)
// from an env file you pass with --env-file. Never prints the credential.
//
//   node --env-file=<storage env> scripts/storage-cors.mjs set <origin>...
//       PutBucketCors: one rule, the given origins, methods PUT/GET/HEAD, request
//       header content-type, MaxAge 3000. Replaces any existing rules.
//   node --env-file=<storage env> scripts/storage-cors.mjs get
//       GetBucketCors: print the bucket's current CORS XML.
//   node --env-file=<storage env> scripts/storage-cors.mjs smoke [<origin>]
//       Presigned PUT of a tiny object under smoke/, a wrong-type PUT (expect 403), a
//       presigned GET, HEAD, then DELETE. With an origin, also checks the CORS preflight
//       for a browser PUT from that origin.
//
//   staging:    set https://dev--bocc-backend.netlify.app http://localhost:4321
//   production: set https://716coffee.club
import { createHash, randomUUID } from "node:crypto";
import { createStorage, readStorageEnv } from "../src/lib/admin/storage.mjs";

const [cmd, ...args] = process.argv.slice(2);
const r = readStorageEnv();
if (!r.enabled) {
  console.error(r.message);
  process.exit(1);
}
const storage = createStorage(r.config);
const where = `bucket ${r.config.bucket} at ${r.config.endpoint}`;

function parseOrigin(o) {
  const u = new URL(o);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.origin !== o || !(u.protocol === "https:" || (u.protocol === "http:" && local))) {
    throw new Error(`not an https origin (no path, no trailing slash): ${o}`);
  }
  return o;
}

async function check(res, what) {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what} failed: ${res.status} ${text.slice(0, 500)}`);
  return text;
}

async function setCors(origins) {
  if (!origins.length) throw new Error("usage: set <origin>...");
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><CORSRule>' +
    origins.map((o) => `<AllowedOrigin>${esc(parseOrigin(o))}</AllowedOrigin>`).join("") +
    "<AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod>" +
    "<AllowedHeader>content-type</AllowedHeader><MaxAgeSeconds>3000</MaxAgeSeconds>" +
    "</CORSRule></CORSConfiguration>";
  const md5 = createHash("md5").update(body).digest("base64");
  const headers = { "content-md5": md5, "content-type": "application/xml" };
  const url = storage.presignBucket({ method: "PUT", query: { cors: "" }, headers });
  await check(await fetch(url, { method: "PUT", headers: { "Content-MD5": md5, "Content-Type": "application/xml" }, body }), "PutBucketCors");
  console.log(`CORS set on ${where}: ${origins.join(", ")}`);
}

async function getCors() {
  const res = await fetch(storage.presignBucket({ method: "GET", query: { cors: "" } }));
  console.log(res.status === 404 ? "(no CORS configuration)" : await check(res, "GetBucketCors"));
}

async function smoke(origin) {
  const key = `smoke/${new Date().toISOString().slice(0, 10)}-${randomUUID()}.txt`;
  const body = `bocc storage smoke ${new Date().toISOString()}\n`;
  const step = (s) => console.log(`  ok  ${s}`);
  console.log(`smoke test on ${where}, key ${key}`);
  try {
    if (origin) {
      const put = storage.presignPut({ key, contentType: "text/plain" });
      const pre = await fetch(put.url, {
        method: "OPTIONS",
        headers: { Origin: parseOrigin(origin), "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type" },
      });
      await pre.body?.cancel();
      const allow = pre.headers.get("access-control-allow-origin");
      if (!pre.ok || (allow !== origin && allow !== "*")) throw new Error(`CORS preflight from ${origin}: ${pre.status}, allow-origin ${allow}`);
      step(`CORS preflight for PUT from ${origin} (${pre.status}, allow-origin ${allow})`);
    }
    const put = storage.presignPut({ key, contentType: "text/plain", contentLength: Buffer.byteLength(body) });
    const wrong = await fetch(put.url, { method: "PUT", headers: { "Content-Type": "text/html" }, body });
    await wrong.body?.cancel();
    if (wrong.status !== 403) throw new Error(`a PUT with the wrong content type got ${wrong.status}, expected 403`);
    step(`wrong content type refused (${wrong.status})`);
    const big = await fetch(put.url, { method: "PUT", headers: put.headers, body: `${body}x` });
    await big.body?.cancel();
    if (big.status !== 403) throw new Error(`a PUT with a different size got ${big.status}, expected 403`);
    step(`wrong size refused (${big.status})`);
    await check(await fetch(put.url, { method: "PUT", headers: put.headers, body }), "presigned PUT");
    step("presigned PUT (content-type and content-length signed)");
    const got = await fetch(storage.presignGet({ key }).url, origin ? { headers: { Origin: origin } } : {});
    const text = await check(got, "presigned GET");
    if (text !== body) throw new Error("GET returned different bytes");
    step(`presigned GET (${got.headers.get("content-type")}${origin ? `, allow-origin ${got.headers.get("access-control-allow-origin")}` : ""})`);
    const head = await storage.headObject({ key });
    if (!head || head.contentLength !== Buffer.byteLength(body)) throw new Error(`HEAD: ${JSON.stringify(head)}`);
    step(`HEAD (${head.contentType}, ${head.contentLength} bytes)`);
  } finally {
    await storage.deleteObject({ key });
  }
  if (await storage.headObject({ key })) throw new Error("object still there after DELETE");
  step("DELETE (object gone)");
}

try {
  if (cmd === "set") await setCors(args);
  else if (cmd === "get") await getCors();
  else if (cmd === "smoke") await smoke(args[0]);
  else {
    console.error("usage: storage-cors.mjs set <origin>... | get | smoke [<origin>]");
    process.exit(2);
  }
} catch (err) {
  console.error(String(err.message ?? err));
  process.exit(1);
}
