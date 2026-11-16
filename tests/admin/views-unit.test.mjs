// Pure checks for the Phase 2 data views: the CSRF Origin check, CSV escaping, the
// correction rules (and that they match the check-in form's), date parsing.
// No database queries (the modules are imported with the test env so auth.mjs loads).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { useAdminEnv } from "./helpers.mjs";

useAdminEnv();
const { checkOrigin, expectedOrigin } = await import("../../src/lib/admin/csrf.mjs");
const { csvCell, toCsv } = await import("../../src/lib/admin/email-list.mjs");
const { validateCorrection, sanitizeText, isValidPhone, isUuid } = await import("../../src/lib/admin/attendees.mjs");
const { parseDate } = await import("../../src/lib/admin/checkins.mjs");
const { pool } = await import("../../src/lib/auth/auth.mjs");
await pool.end();

const backendValidation = createRequire(import.meta.url)("../../backend/netlify/functions/utils/validation.js");

const post = (origin, method = "POST") =>
  new Request("http://localhost:4321/api/admin/x", { method, headers: origin === undefined ? {} : { origin } });

describe("checkOrigin", () => {
  const origin = "https://716coffee.club";
  test("accepts only the exact BETTER_AUTH_URL origin", () => {
    assert.equal(checkOrigin(post(origin), { origin }), null);
    for (const bad of ["https://evil.example", "http://716coffee.club", "https://716coffee.club:8443", "https://sub.716coffee.club", "null", undefined]) {
      assert.equal(checkOrigin(post(bad), { origin })?.status, 403, `refuses ${bad}`);
    }
  });
  test("refuses anything but POST, and refuses when no origin is configured", () => {
    assert.equal(checkOrigin(post(origin, "GET"), { origin }).status, 405);
    assert.equal(checkOrigin(post(origin), { origin: null }).status, 403);
  });
  test("expectedOrigin normalises BETTER_AUTH_URL", () => {
    assert.equal(expectedOrigin({ BETTER_AUTH_URL: "https://716coffee.club/" }), "https://716coffee.club");
    assert.equal(expectedOrigin({}), null);
    assert.equal(expectedOrigin({ BETTER_AUTH_URL: "not a url" }), null);
  });
});

describe("CSV", () => {
  test("cells that a spreadsheet would run as a formula get a leading apostrophe", () => {
    for (const s of ["=1+1", "+1", "-1", "@SUM(A1)", "\t=1", "\r=1"]) {
      assert.ok(csvCell(s).replace(/^"/, "").startsWith("'"), `guards ${JSON.stringify(s)}`);
    }
    assert.equal(csvCell("=HYPERLINK(\"http://x\",\"y\")"), `"'=HYPERLINK(""http://x"",""y"")"`);
    assert.equal(csvCell("Ann O'Neil"), "Ann O'Neil");
    assert.equal(csvCell("a-b"), "a-b", "a dash inside is fine");
  });
  test("RFC 4180 quoting, CRLF rows, null as empty", () => {
    assert.equal(toCsv(["a", "b"], [["x,y", null], ["line\nbreak", 'q"q']]),
      'a,b\r\n"x,y",\r\n"line\nbreak","q""q"\r\n');
  });
});

describe("validateCorrection", () => {
  test("the copied rules match the check-in form's validation.js", () => {
    for (const s of ["  Ann   <b>Lee</b> ", "javascript:alert(1)", "x onclick=y", "<script>", 42, null]) {
      assert.equal(sanitizeText(s), backendValidation.sanitizeText(s), `sanitizeText(${JSON.stringify(s)})`);
    }
    for (const p of ["", "(716) 555-0100", "+1 716 555 0100", "555-01", "716-555-0100x2", "1".repeat(16), "abc"]) {
      assert.equal(isValidPhone(p), backendValidation.isValidPhone(p), `isValidPhone(${p})`);
    }
  });
  test("sanitizes, requires a name, nulls empty business/phone", () => {
    assert.deepEqual(validateCorrection({ name: "  Ann <i>Lee</i> ", businessName: " ", phone: "" }),
      { ok: true, errors: [], values: { name: "Ann Lee", businessName: null, phone: null } });
    const bad = validateCorrection({ name: "<b></b>", businessName: "x".repeat(201), phone: "call me" });
    assert.equal(bad.ok, false);
    assert.equal(bad.errors.length, 3);
    assert.equal(validateCorrection({}).ok, false);
    assert.equal(validateCorrection({ name: ["array"] }).ok, false, "non-strings are treated as empty");
  });
});

describe("misc", () => {
  test("parseDate accepts only real YYYY-MM-DD dates", () => {
    assert.equal(parseDate("2026-11-17"), "2026-11-17");
    for (const d of ["2026-02-30", "2026-1-01", "2026-11-17T00:00", "", null, "x'; drop table"]) assert.equal(parseDate(d), null);
  });
  test("isUuid", () => {
    assert.ok(isUuid("123e4567-e89b-12d3-a456-426614174000"));
    assert.ok(!isUuid("123"));
    assert.ok(!isUuid("123e4567-e89b-12d3-a456-426614174000' or 1=1"));
  });
});
