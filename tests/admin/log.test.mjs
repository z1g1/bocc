import { test } from "node:test";
import assert from "node:assert/strict";
import { adminFailure } from "../../src/lib/admin/log.mjs";

test("adminFailure logs the message with connection strings redacted and returns a bare 500", async () => {
  const lines = [];
  const orig = console.error;
  console.error = (m) => lines.push(m);
  try {
    const r = adminFailure("middleware", Object.assign(new Error("connect to postgresql://admin_app:hunter2@ep-x.example/neondb failed"), { code: "28P01" }));
    assert.equal(r.status, 500);
    assert.equal(await r.text(), "Internal Server Error");
  } finally {
    console.error = orig;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[admin\] middleware failed: Error: connect to <redacted-url> failed \(28P01\)/);
  assert.doesNotMatch(lines[0], /hunter2/);
});
