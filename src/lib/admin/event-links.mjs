// An event's listings (event_links: Luma, Eventbrite, Facebook, LinkedIn) for the admin
// event page (ADR 0009 decision 3, plan Phase 4). Admin only: the CALLER checks
// requireRole(locals, "admin") and, for changes, checkOrigin; after a change it purges
// the public page (src/lib/site/purge.mjs). Parameterized SQL only, as admin_app
// (SELECT/INSERT/UPDATE/DELETE on event_links, migration 20261121120000).
// The URL and id rules, and the readiness checklist, are in ./event-links-rules.mjs.
//
// Reads (take `db`, the pool or a client, first):
//   getLinks(db, date)            -> { luma: { url, externalId, updatedAt } | null, eventbrite: …, … }
//   linkSummaries(db, dates)      -> Map date -> { listings, lumaId } for the lists
//
// Writes (the change and its audit_log row are ONE transaction, via withAudit; a save
// that changes nothing writes nothing and returns { changed: false }; target_id is the
// date, details.platform the listing):
//   setLink(actor, date, platform, { url, externalId })   event_link.set
//       Creates the events row (`scheduled`) in the same transaction if the date has none
//       (details.created = true). externalId only for Luma; blank = no embed id.
//   clearLink(actor, date, platform)                       event_link.delete
//       details.before records what was removed.
//   setLinkInTransaction(client, actor, date, platform, input, extraDetails)
//       setLink's core inside the caller's own transaction (the LinkedIn post fills the
//       linkedin_event listing with its ledger move): writes the event_link.set audit row
//       itself, extraDetails merged into its details -> { changed }
//
// Errors: ValidationError (400; .errors is { url | externalId | platform: message }).

import { withAudit, writeAudit } from "./db.mjs";
import { parseDate, ValidationError } from "./events.mjs";
import { PLATFORM_KEYS, isPlatform, normaliseLinkUrl, normaliseLumaId } from "./event-links-rules.mjs";

export * from "./event-links-rules.mjs";

/** @returns {Promise<Record<string, { url: string, externalId: string|null, updatedAt: Date } | null>>} */
export async function getLinks(db, date) {
  if (!parseDate(date)) throw new Error("getLinks: date must be YYYY-MM-DD");
  const { rows } = await db.query(
    `select platform, url, external_id as "externalId", updated_at as "updatedAt"
       from public.event_links where event_date = $1::date`, [date]);
  const out = Object.fromEntries(PLATFORM_KEYS.map((p) => [p, null]));
  for (const { platform, ...link } of rows) out[platform] = link;
  return out;
}

/** Listings count and whether Luma has its embed id, for each date (missing dates: 0). */
export async function linkSummaries(db, dates) {
  const out = new Map(dates.map((d) => [d, { listings: 0, lumaId: false }]));
  if (dates.length === 0) return out;
  const { rows } = await db.query(
    `select event_date::text as date, count(*)::int as n,
            bool_or(platform = 'luma' and external_id is not null) as "lumaId"
       from public.event_links where event_date = any($1::date[]) group by event_date`, [dates]);
  for (const r of rows) out.set(r.date, { listings: r.n, lumaId: r.lumaId });
  return out;
}

/** Form input -> { url, externalId }; throws ValidationError. */
export function validateLinkInput(platform, input) {
  if (!isPlatform(platform)) throw new ValidationError({ platform: "Unknown platform." });
  const errors = {};
  let url = null, externalId = null;
  try { url = normaliseLinkUrl(platform, input?.url); } catch (e) { errors.url = e.message; }
  if (platform === "luma") {
    try { externalId = normaliseLumaId(input?.externalId); } catch (e) { errors.externalId = e.message; }
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return { url, externalId };
}

const NOOP = Symbol("noop");
async function audited(actorUserId, date, fn) {
  try {
    await withAudit(actorUserId, fn, (r) => ({ action: r.action, targetTable: "event_links", targetId: date, details: r.details }));
    return { changed: true };
  } catch (err) {
    if (err === NOOP) return { changed: false };
    throw err;
  }
}

function checkDate(date) {
  if (!parseDate(date)) throw new ValidationError({ date: "Not a date (YYYY-MM-DD)." });
}

/** The upsert, inside a transaction: its audit entry, or null when nothing changes. */
async function upsertLink(client, date, platform, v) {
  const ins = await client.query(
    `insert into public.events (event_date) values ($1::date) on conflict (event_date) do nothing returning event_date`, [date]);
  const created = ins.rowCount === 1;
  const { rows } = await client.query(
    `select url, external_id from public.event_links where event_date = $1::date and platform = $2 for update`, [date, platform]);
  const before = rows[0] ?? null;
  if (before && before.url === v.url && (before.external_id ?? null) === v.externalId) return null;
  await client.query(
    `insert into public.event_links (event_date, platform, url, external_id) values ($1::date, $2, $3, $4)
     on conflict (event_date, platform) do update set url = excluded.url, external_id = excluded.external_id`,
    [date, platform, v.url, v.externalId]);
  return {
    action: "event_link.set",
    details: { platform, created, before, after: { url: v.url, external_id: v.externalId } },
  };
}

/** Set (add or replace) one platform's listing. */
export async function setLink(actorUserId, date, platform, input) {
  checkDate(date);
  const v = validateLinkInput(platform, input);
  return audited(actorUserId, date, async (client) => (await upsertLink(client, date, platform, v)) ?? Promise.reject(NOOP));
}

/**
 * setLink inside the caller's transaction (`client` from its withAudit): the same
 * validation, upsert and event_link.set audit row, with `extraDetails` added to it.
 * @returns {Promise<{ changed: boolean }>}
 */
export async function setLinkInTransaction(client, actorUserId, date, platform, input, extraDetails = {}) {
  checkDate(date);
  const v = validateLinkInput(platform, input);
  const entry = await upsertLink(client, date, platform, v);
  if (!entry) return { changed: false };
  await writeAudit(client, actorUserId, { action: entry.action, targetTable: "event_links", targetId: date, details: { ...entry.details, ...extraDetails } });
  return { changed: true };
}

/** Remove one platform's listing. */
export async function clearLink(actorUserId, date, platform) {
  checkDate(date);
  if (!isPlatform(platform)) throw new ValidationError({ platform: "Unknown platform." });
  return audited(actorUserId, date, async (client) => {
    const { rows } = await client.query(
      `delete from public.event_links where event_date = $1::date and platform = $2 returning url, external_id`, [date, platform]);
    if (rows.length === 0) throw NOOP;
    return { action: "event_link.delete", details: { platform, before: rows[0] } };
  });
}
