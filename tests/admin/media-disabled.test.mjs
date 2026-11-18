// Media switched off (ADR 0010): with no STORAGE_* variables the admin keeps working,
// the event page shows a message and no upload UI, and every media API answers 503.
// Its own file, so its own process: the STORAGE_* variables from scripts/test-db.sh
// are removed before anything reads them.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { OWNER_URL, connect, unique, useAdminEnv } from "./helpers.mjs";

for (const k of Object.keys(process.env)) if (k.startsWith("STORAGE_")) delete process.env[k];

const port = await new Promise((resolve, reject) => {
  const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  s.on("error", reject);
});
const BASE = `http://localhost:${port}`;
useAdminEnv();
process.env.BETTER_AUTH_URL = BASE;
process.env.ASTRO_TELEMETRY_DISABLED = "1";

const { pool } = await import("../../src/lib/auth/auth.mjs");
const { handleAuthRequest } = await import("../../src/lib/auth/handler.mjs");
const { withAudit } = await import("../../src/lib/admin/db.mjs");
const { createUser, grantRole } = await import("../../src/lib/admin/users.mjs");
const { getStorage } = await import("../../src/lib/admin/storage.mjs");
const { STORAGE_OFF_MESSAGE } = await import("../../src/lib/admin/media-http.mjs");

const PASSWORD = "correct horse battery staple";
let owner;
before(async () => { owner = await connect(OWNER_URL); });
after(async () => { await owner?.end(); await pool.end(); });

describe("media with storage not configured", { timeout: 300_000 }, () => {
  let server, cookie;
  const root = fileURLToPath(new URL("../../", import.meta.url));

  before(async () => {
    const { dev } = await import("astro");
    server = await dev({ root, logLevel: "error", server: { port, host: "localhost" } });
    const user = await createUser({ email: `${unique("mdoff")}@example.com`, name: "Media Off", password: PASSWORD });
    await withAudit(null, (c) => grantRole(c, user.id, "admin"), { action: "test.grant" });
    const res = await handleAuthRequest(new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, "x-nf-client-connection-ip": "198.21.0.1" },
      body: JSON.stringify({ email: user.email, password: PASSWORD }),
    }));
    assert.equal(res.status, 200);
    cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).filter((c) => !c.endsWith("=")).join("; ");
  });
  after(async () => { await server?.stop(); });

  test("getStorage() is disabled", () => {
    assert.equal(getStorage().storage, null);
  });

  test("every media API answers 503 with a clear message, and writes nothing", async () => {
    const date = "2025-06-10";
    const id = "00000000-0000-4000-8000-000000000000";
    const tries = [
      ["/api/admin/media/uploads", { eventDate: date, kind: "signin_board", original: { contentType: "image/jpeg", size: 1 }, display: { size: 1 }, thumb: { size: 1 } }],
      [`/api/admin/media/${id}/complete`, {}],
      [`/api/admin/media/${id}/delete`, {}],
    ];
    for (const [path, json] of tries) {
      const res = await fetch(`${BASE}${path}`, {
        method: "POST", redirect: "manual",
        headers: { cookie, origin: BASE, "content-type": "application/json" }, body: JSON.stringify(json),
      });
      assert.equal(res.status, 503, path);
      assert.deepEqual(await res.json(), { error: STORAGE_OFF_MESSAGE });
    }
    const { rowCount } = await owner.query("select 1 from events where event_date = $1", [date]);
    assert.equal(rowCount, 0);
  });

  test("the event page shows the message, no upload form and no script; the CSP has no bucket", async () => {
    const res = await fetch(`${BASE}/admin/events/2025-06-17/`, { headers: { cookie }, redirect: "manual" });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-security-policy"), /img-src 'self' data:;/);
    const page = await res.text();
    assert.ok(page.includes(STORAGE_OFF_MESSAGE.replace("'", "&#39;")) || page.includes(STORAGE_OFF_MESSAGE), "message shown");
    assert.ok(!page.includes("data-media-upload"), "no upload form");
    assert.ok(!page.includes("/js/admin-media.js"), "no upload script");
  });
});
