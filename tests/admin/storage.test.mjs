// Real presigned round trips against the throwaway MinIO from scripts/test-db.sh,
// which writes STORAGE_* into the test env. Skipped when MinIO isn't available.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getStorage, mediaKey } from "../../src/lib/admin/storage.mjs";

const skip = process.env.STORAGE_ENDPOINT ? false : "MinIO not running (STORAGE_ENDPOINT unset)";

describe("presigned URLs against MinIO", { skip }, () => {
  const storage = () => {
    const { storage: s, message } = getStorage();
    assert.ok(s, message ?? "");
    return s;
  };
  const key = () => mediaKey("2026-11-24", randomUUID(), "display", "jpg");
  const body = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

  test("PUT then GET returns the same bytes and type; HEAD sees it; DELETE removes it", async () => {
    const s = storage();
    const k = key();
    const put = s.presignPut({ key: k, contentType: "image/jpeg", contentLength: body.length });
    const res = await fetch(put.url, { method: put.method, headers: put.headers, body });
    assert.equal(res.status, 200, await res.text());

    const got = await fetch(s.presignGet({ key: k }).url);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(new Uint8Array(await got.arrayBuffer()), body);

    const head = await s.headObject({ key: k });
    assert.equal(head.contentType, "image/jpeg");
    assert.equal(head.contentLength, body.length);

    await s.deleteObject({ key: k });
    assert.equal(await s.headObject({ key: k }), null);
    await s.deleteObject({ key: k }); // already gone: not an error
  });

  test("the PUT URL refuses a different content type or size, and stores nothing", async () => {
    const s = storage();
    const k = key();
    const put = s.presignPut({ key: k, contentType: "image/jpeg", contentLength: body.length });
    const wrongType = await fetch(put.url, { method: "PUT", headers: { "Content-Type": "text/html" }, body });
    assert.equal(wrongType.status, 403, await wrongType.text());
    const wrongSize = await fetch(put.url, { method: "PUT", headers: put.headers, body: new Uint8Array(body.length + 1) });
    assert.equal(wrongSize.status, 403, await wrongSize.text());
    assert.equal(await s.headObject({ key: k }), null);
  });

  test("a URL is only good for its own method and key, and not after it expires", async () => {
    const s = storage();
    const k = key();
    const put = s.presignPut({ key: k, contentType: "image/jpeg" });
    assert.equal((await fetch(put.url, { method: "PUT", headers: put.headers, body })).status, 200);
    try {
      const get = s.presignGet({ key: k });
      const asPut = await fetch(get.url, { method: "PUT", headers: put.headers, body });
      assert.equal(asPut.status, 403, "a GET URL can't upload");
      const otherKey = get.url.replace("/display.jpg?", "/original.jpg?");
      assert.equal((await fetch(otherKey)).status, 403, "the signature covers the key");

      const past = new Date(Date.now() - 120_000);
      const { createStorage, readStorageEnv } = await import("../../src/lib/admin/storage.mjs");
      const old = createStorage(readStorageEnv().config, { now: () => past });
      assert.equal((await fetch(old.presignGet({ key: k, expiresIn: 60 }).url)).status, 403, "expired");

      const r = readStorageEnv();
      const forged = createStorage({ ...r.config, secretAccessKey: "not-the-secret" });
      assert.equal((await fetch(forged.presignGet({ key: k }).url)).status, 403, "wrong secret");
    } finally {
      await s.deleteObject({ key: k });
    }
  });
});
