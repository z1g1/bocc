// Pure checks for src/lib/admin/storage.mjs (no network, no database): the SigV4
// signer against AWS's documented example, env validation, keys and the CSP option.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GET_EXPIRES, EMPTY_SHA256, createStorage, extForContentType, mediaKey, readStorageEnv, storageOrigin,
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

// AWS SigV4 docs, "Authenticating Requests: Using the Authorization Header (AWS
// Signature Version 4)", example "GET Object": test.txt with Range: bytes=0-9 and an
// empty payload, virtual-hosted style, same credentials and clock as above.
describe("SigV4 header signing (server-side requests)", () => {
  test("matches AWS's documented GET Object Authorization header", () => {
    const s = createStorage(aws, { now: awsClock });
    const r = s.signRequest({ method: "GET", key: "test.txt", headers: { Range: "bytes=0-9" } });
    assert.equal(r.url, "https://examplebucket.s3.amazonaws.com/test.txt");
    assert.deepEqual(r.headers, {
      range: "bytes=0-9",
      "x-amz-content-sha256": EMPTY_SHA256,
      "x-amz-date": "20130524T000000Z",
      authorization: "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    });
  });

  test("headObject and deleteObject send path-style URLs with no X-Amz- query; the signature is in headers", async () => {
    const calls = [];
    const fetch = async (url, init) => { calls.push({ url, init }); return new Response(null, { status: 404 }); };
    const cfg = readStorageEnv(neonEnv).config;
    const s = createStorage(cfg, { now: awsClock, fetch });
    const key = "events/2026-11-24/0b6f6a43-3c5e-4f0e-9a51-7b3c2f9d1e20/original.jpg";
    assert.equal(await s.headObject({ key }), null);
    await s.deleteObject({ key });
    assert.deepEqual(calls.map((c) => c.init.method), ["HEAD", "DELETE"]);
    for (const { url, init } of calls) {
      assert.equal(url, `${neonEnv.STORAGE_ENDPOINT}/bocc-media/${key}`);
      const u = new URL(url);
      assert.equal(u.search, "");
      assert.doesNotMatch(url, /X-Amz-|nak_live_example|Signature/i);
      assert.equal("host" in init.headers, false, "fetch sets Host from the URL");
      assert.equal(init.headers["x-amz-content-sha256"], EMPTY_SHA256);
      assert.equal(init.headers["x-amz-date"], "20130524T000000Z");
      assert.match(init.headers.authorization,
        /^AWS4-HMAC-SHA256 Credential=nak_live_example\/20130524\/us-east-2\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
      assert.doesNotMatch(init.headers.authorization, /nsk_live_example/);
    }
    assert.notEqual(calls[0].init.headers.authorization, calls[1].init.headers.authorization, "the method is signed");
  });

  test("getObject reads the bytes with a header-signed GET (no query), null when missing", async () => {
    const calls = [];
    const body = Buffer.from("cover bytes");
    const fetch = async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1
        ? new Response(body, { status: 200, headers: { "content-type": "image/jpeg" } })
        : new Response("no", { status: 404 });
    };
    const s = createStorage(readStorageEnv(neonEnv).config, { now: awsClock, fetch });
    const key = "events/2026-11-24/0b6f6a43-3c5e-4f0e-9a51-7b3c2f9d1e20/cover.jpg";
    assert.deepEqual(await s.getObject({ key }), { contentType: "image/jpeg", bytes: body });
    assert.equal(await s.getObject({ key }), null);
    for (const { url, init } of calls) {
      assert.equal(init.method, "GET");
      assert.equal(url, `${neonEnv.STORAGE_ENDPOINT}/bocc-media/${key}`);
      assert.doesNotMatch(url, /X-Amz-|Signature/i);
      assert.match(init.headers.authorization, /^AWS4-HMAC-SHA256 /);
    }
  });

  test("getObject refuses an object over its byte cap, and any other failure", async () => {
    const big = createStorage(readStorageEnv(neonEnv).config, {
      now: awsClock, fetch: async () => new Response(Buffer.alloc(11), { status: 200, headers: { "content-length": "11" } }),
    });
    await assert.rejects(big.getObject({ key: "a/b.jpg", maxBytes: 10 }), /too large/);
    const broken = createStorage(readStorageEnv(neonEnv).config, { now: awsClock, fetch: async () => new Response("x", { status: 500 }) });
    await assert.rejects(broken.getObject({ key: "a/b.jpg" }), /GET failed with 500/);
  });

  test("refuses bad keys", () => {
    const s = createStorage(aws, { now: awsClock });
    for (const key of [null, "", "../a", "a?b"]) {
      assert.throws(() => s.signRequest({ method: "HEAD", key }), /invalid object key/, String(key));
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
    assert.equal(mediaKey("2026-11-24", id, "cover", "jpg"), `events/2026-11-24/${id}/cover.jpg`);
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
