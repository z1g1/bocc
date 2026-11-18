// Pure checks for src/lib/admin/storage.mjs (no network, no database): the SigV4
// signer against AWS's documented example, env validation, keys and the CSP option.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GET_EXPIRES, createStorage, extForContentType, mediaKey, readStorageEnv, storageOrigin,
} from "../../src/lib/admin/storage.mjs";
import { adminCsp } from "../../src/lib/admin/headers.mjs";

// AWS SigV4 docs, "Authenticating Requests: Using Query Parameters (AWS Signature
// Version 4)", example: GET examplebucket/test.txt, 24 h, virtual-hosted style.
const aws = {
  endpoint: "https://s3.amazonaws.com",
  bucket: "examplebucket",
  region: "us-east-1",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  forcePathStyle: false,
};
const awsClock = () => new Date("2013-05-24T00:00:00Z");

const neonEnv = {
  STORAGE_ENDPOINT: "https://br-example-a1b2c3d4.storage.c-1.us-east-2.aws.neon.tech",
  STORAGE_BUCKET: "bocc-media",
  STORAGE_ACCESS_KEY_ID: "nak_live_example",
  STORAGE_SECRET_ACCESS_KEY: "nsk_live_example",
};

describe("SigV4 presigning", () => {
  test("matches AWS's documented presigned GET", () => {
    const s = createStorage(aws, { now: awsClock });
    const { url } = s.presignGet({ key: "test.txt", expiresIn: 86400 });
    assert.equal(url,
      "https://examplebucket.s3.amazonaws.com/test.txt" +
      "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
      "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
      "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
      "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  });

  test("path-style puts the bucket in the path; the signature changes with it", () => {
    const s = createStorage({ ...aws, forcePathStyle: true }, { now: awsClock });
    const { url } = s.presignGet({ key: "test.txt", expiresIn: 86400 });
    assert.ok(url.startsWith("https://s3.amazonaws.com/examplebucket/test.txt?"));
    assert.ok(!url.includes("aeeed9bb"));
  });

  test("PUT signs content-type (and content-length when given); GET defaults to 10 minutes", () => {
    const s = createStorage(aws, { now: awsClock });
    const put = s.presignPut({ key: "events/2026-11-24/x/original.jpg", contentType: "image/jpeg" });
    assert.equal(put.method, "PUT");
    assert.deepEqual(put.headers, { "Content-Type": "image/jpeg" });
    assert.match(put.url, /X-Amz-SignedHeaders=content-type%3Bhost&/);
    assert.match(put.url, /X-Amz-Expires=300&/);
    const sized = s.presignPut({ key: "a.jpg", contentType: "image/jpeg", contentLength: 1234 });
    assert.match(sized.url, /X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost&/);
    assert.deepEqual(sized.headers, { "Content-Type": "image/jpeg" }, "the browser sets Content-Length itself");
    const get = s.presignGet({ key: "a.jpg" });
    assert.match(get.url, new RegExp(`X-Amz-Expires=${DEFAULT_GET_EXPIRES}&`));
    assert.equal(get.expiresAt.getTime() - awsClock().getTime(), DEFAULT_GET_EXPIRES * 1000);
  });

  test("refuses bad keys, content types and expiries", () => {
    const s = createStorage(aws, { now: awsClock });
    for (const key of ["", "/a", "a//b", "../a", "a/../b", "a b", "a?b", "a\nb", "ä"]) {
      assert.throws(() => s.presignGet({ key }), /invalid object key/, JSON.stringify(key));
    }
    for (const contentType of ["", "image/jpeg; charset=x", "image/jpeg\r\nX: y", "jpeg", undefined]) {
      assert.throws(() => s.presignPut({ key: "a.jpg", contentType }), /contentType/, String(contentType));
    }
    assert.throws(() => s.presignPut({ key: "a.jpg", contentType: "image/jpeg", contentLength: -1 }), /contentLength/);
    for (const expiresIn of [0, 1.5, 604801]) {
      assert.throws(() => s.presignGet({ key: "a.jpg", expiresIn }), /expiresIn/);
    }
  });
});

describe("readStorageEnv", () => {
  test("nothing set: media off, with a clear message and no throw", () => {
    const r = readStorageEnv({});
    assert.equal(r.enabled, false);
    assert.match(r.message, /not configured/);
    assert.equal(storageOrigin({}), null);
  });

  test("Neon defaults: us-east-2, path-style", () => {
    const r = readStorageEnv(neonEnv);
    assert.equal(r.enabled, true);
    assert.equal(r.config.region, "us-east-2");
    assert.equal(r.config.forcePathStyle, true);
    assert.equal(storageOrigin(neonEnv), neonEnv.STORAGE_ENDPOINT);
    assert.equal(storageOrigin({ ...neonEnv, STORAGE_FORCE_PATH_STYLE: "false" }),
      "https://bocc-media.br-example-a1b2c3d4.storage.c-1.us-east-2.aws.neon.tech");
  });

  test("a partial or bad set is disabled, listing every problem by name and never a value", () => {
    const r = readStorageEnv({
      STORAGE_ENDPOINT: "http://storage.example.com/path",
      STORAGE_BUCKET: "Bad_Bucket",
      STORAGE_SECRET_ACCESS_KEY: "super-secret-value",
      STORAGE_FORCE_PATH_STYLE: "maybe",
    });
    assert.equal(r.enabled, false);
    for (const m of [/STORAGE_ACCESS_KEY_ID is not set/, /STORAGE_ENDPOINT must be an origin/, /STORAGE_BUCKET/, /STORAGE_FORCE_PATH_STYLE/]) {
      assert.match(r.message, m);
    }
    assert.ok(!r.message.includes("super-secret-value"));
    assert.match(readStorageEnv({ ...neonEnv, STORAGE_ENDPOINT: "http://storage.example.com" }).message, /https/);
    assert.equal(readStorageEnv({ ...neonEnv, STORAGE_ENDPOINT: "http://localhost:9000" }).enabled, true);
  });
});

describe("media keys", () => {
  const id = "0b6f6a43-3c5e-4f0e-9a51-7b3c2f9d1e20";
  test("built only from server-controlled parts", () => {
    assert.equal(mediaKey("2026-11-24", id, "original", "jpg"), `events/2026-11-24/${id}/original.jpg`);
    assert.equal(mediaKey("2026-11-24", id, "thumb", "jpg"), `events/2026-11-24/${id}/thumb.jpg`);
  });
  test("refuses anything else", () => {
    assert.throws(() => mediaKey("2026-02-30", id, "original", "jpg"), /eventDate/);
    assert.throws(() => mediaKey("2026-11-24/../x", id, "original", "jpg"), /eventDate/);
    assert.throws(() => mediaKey("2026-11-24", "../../etc", "original", "jpg"), /uuid/);
    assert.throws(() => mediaKey("2026-11-24", id.toUpperCase(), "original", "jpg"), /uuid/);
    assert.throws(() => mediaKey("2026-11-24", id, "huge", "jpg"), /variant/);
    assert.throws(() => mediaKey("2026-11-24", id, "original", "gif"), /extension/);
    assert.throws(() => mediaKey("2026-11-24", id, "display", "heic"), /originals only/);
    assert.throws(() => mediaKey("2026-11-24", id, "thumb", "heif"), /originals only/);
  });
  test("extension per allowed content type", () => {
    assert.equal(extForContentType("image/jpeg"), "jpg");
    assert.equal(extForContentType("video/quicktime"), "mov");
    assert.equal(extForContentType("image/heic"), "heic"); // imported originals only
    assert.equal(extForContentType("image/heif"), "heif");
    assert.equal(mediaKey("2026-11-24", id, "original", "heic"), `events/2026-11-24/${id}/original.heic`);
    assert.equal(extForContentType("image/gif"), null);
    assert.equal(extForContentType("toString"), null);
  });
});

describe("admin CSP with media", () => {
  test("adds only the bucket origin to img-src, media-src and connect-src", () => {
    const csp = adminCsp({ mediaOrigin: neonEnv.STORAGE_ENDPOINT });
    const o = neonEnv.STORAGE_ENDPOINT;
    assert.match(csp, new RegExp(`img-src 'self' data: blob: ${o.replace(/\./g, "\\.")};`));
    assert.match(csp, new RegExp(`connect-src 'self' ${o.replace(/\./g, "\\.")};`));
    assert.match(csp, new RegExp(`media-src 'self' ${o.replace(/\./g, "\\.")};`));
    assert.match(csp, /default-src 'self';/);
    assert.equal(adminCsp({ mediaOrigin: null }), adminCsp(), "media off: unchanged");
  });
});
