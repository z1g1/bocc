// Secrets for the LinkedIn connection (ADR 0012 decision 4). Pure node:crypto.
//
// Both keys are derived from LINKEDIN_TOKEN_KEY with HKDF-SHA256 and a distinct label,
// so the token key and the cookie-signing key are never the same bytes.
//
// Access token at rest (linkedin_connections.token_ciphertext, bytea):
//   [1 byte version = 1][12 byte IV][16 byte GCM tag][ciphertext]
//   AES-256-GCM, AAD "linkedin_connections:<user id>" (TOKEN_AAD_PREFIX), so a row copied onto another
//   user doesn't decrypt. Rotating the key = bump the version byte and keep the old
//   key for decrypting until everyone has reconnected.
//
// OAuth state cookie value: "<payload>.<mac>", both base64url.
//   payload = JSON { s: state, e: expiry (epoch seconds), r: return target }
//   mac     = HMAC-SHA256(state key, "<payload>|<user id>")
// The cookie is bound to the signed-in user and lives 10 minutes. The callback compares
// the `state` query value with the cookie's in constant time.

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const STATE_TTL_SECONDS = 600;
const RETURN_TO = /^(account|\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))$/;

const derive = (key, label) => Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), label, 32));
// The AES-GCM associated data's prefix. It is the table's OLD name (renamed to
// linkedin_authentications by migration 20261203120000, #50) and must stay this literal:
// every stored token was sealed with it, and changing it would make them all fail to
// decrypt. It is a fixed label, not the table's name.
const TOKEN_AAD_PREFIX = "linkedin_connections:";
const aad = (userId) => Buffer.from(`${TOKEN_AAD_PREFIX}${userId}`);

/**
 * @param {string} token
 * @param {{ key: Buffer, userId: string }} opts  key: the 32-byte LINKEDIN_TOKEN_KEY
 * @returns {Buffer}
 */
export function encryptToken(token, { key, userId }) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", derive(key, "bocc linkedin token v1"), iv);
  cipher.setAAD(aad(userId));
  const ct = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
}

/**
 * @param {Buffer} box
 * @param {{ key: Buffer, userId: string }} opts
 * @returns {string}
 * @throws when the key, user or bytes don't match
 */
export function decryptToken(box, { key, userId }) {
  if (!Buffer.isBuffer(box) || box.length <= 1 + IV_BYTES + TAG_BYTES || box[0] !== VERSION) {
    throw new Error("LinkedIn token: unreadable ciphertext");
  }
  const iv = box.subarray(1, 1 + IV_BYTES);
  const tag = box.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", derive(key, "bocc linkedin token v1"), iv);
  decipher.setAAD(aad(userId));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(box.subarray(1 + IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("LinkedIn token: decryption failed (wrong key or tampered row)");
  }
}

const mac = (key, payload, userId) =>
  createHmac("sha256", derive(key, "bocc linkedin oauth state v1")).update(`${payload}|${userId}`).digest("base64url");

const sameText = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * A fresh OAuth state and the signed cookie value that carries it.
 * @param {{ key: Buffer, userId: string, returnTo: string, now?: Date }} opts
 *   returnTo: "account" or an event date YYYY-MM-DD
 * @returns {{ state: string, cookie: string }}
 */
export function signState({ key, userId, returnTo, now = new Date() }) {
  if (!RETURN_TO.test(String(returnTo))) throw new Error("signState: returnTo must be \"account\" or a date");
  const state = randomBytes(32).toString("base64url");
  const e = Math.floor(now.getTime() / 1000) + STATE_TTL_SECONDS;
  const payload = Buffer.from(JSON.stringify({ s: state, e, r: returnTo })).toString("base64url");
  return { state, cookie: `${payload}.${mac(key, payload, userId)}` };
}

/**
 * Check the callback's `state` against the cookie.
 * @param {string|null|undefined} cookie
 * @param {string|null|undefined} state  the callback's ?state=
 * @param {{ key: Buffer, userId: string, now?: Date }} opts
 * @returns {{ ok: true, returnTo: string } | { ok: false, reason: string }}
 */
export function verifyState(cookie, state, { key, userId, now = new Date() }) {
  if (!cookie) return { ok: false, reason: "no state cookie" };
  if (!state) return { ok: false, reason: "no state" };
  const parts = String(cookie).split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed cookie" };
  const [payload, sig] = parts;
  if (!sameText(sig, mac(key, payload, userId))) return { ok: false, reason: "bad signature" };
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed cookie" };
  }
  if (!(Number.isInteger(data?.e) && data.e * 1000 > now.getTime())) return { ok: false, reason: "expired" };
  if (typeof data.s !== "string" || !sameText(data.s, state)) return { ok: false, reason: "state mismatch" };
  if (!RETURN_TO.test(String(data.r))) return { ok: false, reason: "malformed cookie" };
  return { ok: true, returnTo: data.r };
}
