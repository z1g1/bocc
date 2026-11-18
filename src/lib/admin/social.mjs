// The weekly social work order (ADR 0011; plan Phase 5): one social_posts row per event
// and its five social_post_channels rows. Parameterized SQL only, as admin_app
// (SELECT/INSERT/UPDATE on both tables, migration 20261122120000_social_posts.sql).
// The caption, hashtag, publish-time and ready rules are in ./social-rules.mjs.
//
// The CALLER checks the role and, for changes, checkOrigin. The admin event page
// (/admin/events/YYYY-MM-DD/, "admin" only) uses everything here. The social role's
// pages (Phase 5 part B) are meant to use the reads and getWorkOrder(); they never
// see attendees, check-ins or the audit log, and nothing here returns any.
//
// Reads (take `db`, the pool or a client, first):
//   getSocialPost(db, date)              -> post | null
//       { date, videoMediaId, coverNote, baseCaption, extraHashtags[], publishAt, ready,
//         createdAt, updatedAt, channels: { facebook: { caption, firstComment, status,
//         postUrl, verifiedAt, commentPostedAt, notes, updatedAt }, … } }
//       caption / firstComment are the stored overrides (null = the code default).
//   getWorkOrder(db, date)               -> buildWorkOrder() (social-rules.mjs): the post,
//       its final per-channel texts, the video row, the Luma URL, `problems`, and
//       `actionable` (ready and no problems). For a date with no post, `exists: false`
//       and the defaults.
//   readState(db, date)                  -> { event, post, lumaUrl, video } (its inputs)
//
// Writes (each change and its audit_log row are ONE transaction, via withAudit; a save
// that changes nothing writes nothing and returns { changed: false }; target_id is the
// date). The first write creates the events row (`scheduled`) if missing, the post
// (publish_at = Monday 7:00 AM ET before the event) and its five `pending` channel
// rows, in the same transaction (details.created / details.eventCreated).
//   savePost(actor, date, input, { now })        social_post.update
//       baseCaption, extraHashtags ("#a b, c"), coverNote, publishAt (Eastern
//       "YYYY-MM-DDTHH:MM"; blank = the default), ready ("on"/"true"/"1").
//       Ready is refused (ValidationError .errors.ready) while readyProblems() lists
//       anything, and a changed publish time (or switching ready on) must be in the
//       future and not after the event day (.errors.publishAt).
//   setVideo(actor, date, mediaId)               social_post.video
//       a `ready` promo_video of the same event (.errors.video otherwise).
//   saveChannel(actor, date, channel, input)     social_post_channel.update
//       caption / firstComment overrides; blank, or exactly the default, stores NULL
//       (so the channel keeps following the default). On a ready post, a caption over
//       the channel's limit is refused.
// Returns { changed, eventCreated }: the caller purges the public page only when the
// events row was created (nothing here shows on the public page).
//
// Errors: ValidationError (400; .errors is { field: message }) from ./events.mjs.

import { withAudit } from "./db.mjs";
import { parseDate, ValidationError } from "./events.mjs";
import { isUuid } from "./attendees.mjs";
import {
  CHANNEL_KEYS, LIMITS, buildWorkOrder, defaultPublishAt, defaultTexts, easternToUtc, isChannel,
  normaliseHashtags, publishAtProblem,
} from "./social-rules.mjs";

export * from "./social-rules.mjs";

const POST_COLUMNS = `
  p.event_date::text   as date,
  p.video_media_id     as "videoMediaId",
  p.cover_note         as "coverNote",
  p.base_caption       as "baseCaption",
  p.extra_hashtags     as "extraHashtags",
  p.publish_at         as "publishAt",
  p.ready,
  p.created_at         as "createdAt",
  p.updated_at         as "updatedAt"`;

const CHANNEL_COLUMNS = `
  channel, caption, first_comment as "firstComment", status, post_url as "postUrl",
  verified_at as "verifiedAt", comment_posted_at as "commentPostedAt", notes, updated_at as "updatedAt"`;

function requireDate(date, fn) {
  if (!parseDate(date)) throw new Error(`${fn}: date must be YYYY-MM-DD`);
}

/** The post and its channel rows, or null. */
export async function getSocialPost(db, date) {
  requireDate(date, "getSocialPost");
  const [{ rows: [post] }, { rows: channels }] = await Promise.all([
    db.query(`select ${POST_COLUMNS} from public.social_posts p where p.event_date = $1::date`, [date]),
    db.query(`select ${CHANNEL_COLUMNS} from public.social_post_channels where event_date = $1::date`, [date]),
  ]);
  if (!post) return null;
  const byChannel = Object.fromEntries(CHANNEL_KEYS.map((c) => [c, null]));
  for (const { channel, ...rest } of channels) byChannel[channel] = rest;
  return { ...post, channels: byChannel };
}

/** Everything buildWorkOrder() needs for one date. */
export async function readState(db, date) {
  requireDate(date, "readState");
  const [{ rows: [event] }, { rows: [luma] }, post] = await Promise.all([
    db.query(`select status from public.events where event_date = $1::date`, [date]),
    db.query(`select url from public.event_links where event_date = $1::date and platform = 'luma'`, [date]),
    getSocialPost(db, date),
  ]);
  const video = post?.videoMediaId ? await getVideo(db, post.videoMediaId) : null;
  return {
    event: event ? { status: event.status, exists: true } : { status: "scheduled", exists: false },
    post,
    lumaUrl: luma?.url ?? null,
    video,
  };
}

/** The work order for one date (see buildWorkOrder in social-rules.mjs). */
export async function getWorkOrder(db, date) {
  const s = await readState(db, date);
  return buildWorkOrder({ date, ...s });
}

async function getVideo(db, id) {
  const { rows: [v] } = await db.query(
    `select id, event_date::text as "eventDate", kind, status, content_type as "contentType",
            size_bytes::int8 as "sizeBytes", original_key as "originalKey", created_at as "createdAt"
       from public.event_media where id = $1`, [id]);
  return v ? { ...v, sizeBytes: Number(v.sizeBytes) } : null;
}

// ── Validation ───────────────────────────────────────────────────────────────

const str = (v) => (typeof v === "string" ? v : "");
/** Trim, normalise line endings, drop NULs; "" -> null. */
const text = (v) => {
  const t = str(v).replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
  return t === "" ? null : t;
};
const truthy = (v) => ["on", "true", "1", "yes"].includes(str(v).trim().toLowerCase());
const len = (s) => [...s].length;

/**
 * Form input of the post form -> values; throws ValidationError.
 * @returns {{ baseCaption: string|null, coverNote: string|null, extraHashtags: string[], publishAt: Date, ready: boolean }}
 */
export function validatePostInput(date, input) {
  const errors = {};
  const baseCaption = text(input?.baseCaption);
  if (baseCaption !== null && len(baseCaption) > LIMITS.baseCaption) errors.baseCaption = `At most ${LIMITS.baseCaption} characters.`;
  const coverNote = text(input?.coverNote);
  if (coverNote !== null && len(coverNote) > LIMITS.coverNote) errors.coverNote = `At most ${LIMITS.coverNote} characters.`;
  let extraHashtags = [];
  try { extraHashtags = normaliseHashtags(input?.extraHashtags); } catch (e) { errors.extraHashtags = e.message; }
  let publishAt = null;
  const rawPublish = str(input?.publishAt).trim();
  if (rawPublish === "") publishAt = defaultPublishAt(date);
  else {
    try { publishAt = easternToUtc(rawPublish); } catch (e) { errors.publishAt = e.message; }
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return { baseCaption, coverNote, extraHashtags, publishAt, ready: truthy(input?.ready) };
}

/** Channel override input -> { caption, firstComment } (null = default); throws ValidationError. */
export function validateChannelInput(channel, input) {
  if (!isChannel(channel)) throw new ValidationError({ channel: "Unknown channel." });
  const errors = {};
  const caption = text(input?.caption);
  if (caption !== null && len(caption) > LIMITS.caption) errors.caption = `At most ${LIMITS.caption} characters.`;
  const firstComment = text(input?.firstComment);
  if (firstComment !== null && len(firstComment) > LIMITS.firstComment) errors.firstComment = `At most ${LIMITS.firstComment} characters.`;
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return { caption, firstComment };
}

function checkDate(date) {
  if (!parseDate(date)) throw new ValidationError({ date: "Not a date (YYYY-MM-DD)." });
}

// ── Writes ───────────────────────────────────────────────────────────────────

const NOOP = Symbol("noop");

async function audited(actorUserId, date, table, fn) {
  let eventCreated = false;
  try {
    await withAudit(actorUserId, async (client) => {
      const r = await fn(client);
      eventCreated = Boolean(r.details?.eventCreated);
      return r;
    }, (r) => ({ action: r.action, targetTable: table, targetId: date, details: r.details }));
    return { changed: true, eventCreated };
  } catch (err) {
    if (err === NOOP) return { changed: false, eventCreated: false };
    throw err;
  }
}

/**
 * Make sure the events row, the post and its five channel rows exist; lock the post.
 * @returns {Promise<{ eventCreated: boolean, created: boolean, row: object }>}
 */
async function lockPost(client, date) {
  const ev = await client.query(
    `insert into public.events (event_date) values ($1::date) on conflict (event_date) do nothing`, [date]);
  const ins = await client.query(
    `insert into public.social_posts (event_date, publish_at) values ($1::date, $2)
     on conflict (event_date) do nothing`, [date, defaultPublishAt(date)]);
  const created = ins.rowCount === 1;
  if (created) {
    await client.query(
      `insert into public.social_post_channels (event_date, channel)
       select $1::date, c from unnest($2::text[]) as c
       on conflict (event_date, channel) do nothing`, [date, CHANNEL_KEYS]);
  }
  const { rows: [row] } = await client.query(
    `select video_media_id, cover_note, base_caption, extra_hashtags, publish_at, ready
       from public.social_posts where event_date = $1::date for update`, [date]);
  return { eventCreated: ev.rowCount === 1, created, row };
}

const same = (a, b) => {
  if (a instanceof Date || b instanceof Date) return a != null && b != null && new Date(a).getTime() === new Date(b).getTime();
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  return (a ?? null) === (b ?? null);
};
const jsonValue = (v) => (v instanceof Date ? v.toISOString() : v ?? null);
/** Keys whose values differ, as { before, after } holding only those keys. */
function diff(before, after) {
  const b = {}, a = {};
  for (const k of Object.keys(after)) {
    if (!same(before[k], after[k])) { b[k] = jsonValue(before[k]); a[k] = jsonValue(after[k]); }
  }
  return { before: b, after: a, changed: Object.keys(a) };
}

/** The post as getSocialPost() would return it, read inside the transaction, with `over` applied. */
async function stateIn(client, date, over = {}) {
  const s = await readState(client, date);
  const post = { ...s.post, ...over.post };
  if (over.channel) post.channels = { ...post.channels, [over.channel.channel]: { ...post.channels[over.channel.channel], ...over.channel.values } };
  const video = over.post && "videoMediaId" in over.post
    ? (over.post.videoMediaId ? await getVideo(client, over.post.videoMediaId) : null)
    : s.video;
  return buildWorkOrder({ date, ...s, post, video });
}

/** The post form: caption, hashtags, cover note, publish time, ready. */
export async function savePost(actorUserId, date, input, { now = new Date() } = {}) {
  checkDate(date);
  const v = validatePostInput(date, input);
  return audited(actorUserId, date, "social_posts", async (client) => {
    const { eventCreated, created, row } = await lockPost(client, date);
    const after = {
      base_caption: v.baseCaption, cover_note: v.coverNote, extra_hashtags: v.extraHashtags,
      publish_at: v.publishAt, ready: v.ready,
    };
    const d = diff(row, after);
    if (!created && d.changed.length === 0) throw NOOP;
    if (d.changed.includes("publish_at") || (v.ready && !row.ready)) {
      const problem = publishAtProblem(v.publishAt, date, now);
      if (problem) throw new ValidationError({ publishAt: problem });
    }
    if (v.ready) {
      const order = await stateIn(client, date, {
        post: { baseCaption: v.baseCaption, extraHashtags: v.extraHashtags, coverNote: v.coverNote, publishAt: v.publishAt },
      });
      if (order.problems.length) {
        throw new ValidationError({ ready: `Not ready yet: ${order.problems.map((p) => p.message).join(" ")}` });
      }
    }
    await client.query(
      `update public.social_posts
          set base_caption = $2, cover_note = $3, extra_hashtags = $4, publish_at = $5, ready = $6
        where event_date = $1::date`,
      [date, v.baseCaption, v.coverNote, v.extraHashtags, v.publishAt, v.ready]);
    return { action: "social_post.update", details: { created, eventCreated, before: d.before, after: d.after } };
  });
}

/** Attach a ready promo video of the same event. */
export async function setVideo(actorUserId, date, mediaId) {
  checkDate(date);
  if (!isUuid(mediaId)) throw new ValidationError({ video: "Choose a promo video." });
  return audited(actorUserId, date, "social_posts", async (client) => {
    const { eventCreated, created, row } = await lockPost(client, date);
    const { rows: [m] } = await client.query(
      `select event_date::text as date, kind, status from public.event_media where id = $1 for share`, [mediaId]);
    if (!m || m.date !== date || m.kind !== "promo_video") throw new ValidationError({ video: "That isn't a promo video of this event." });
    if (m.status !== "ready") throw new ValidationError({ video: "That video hasn't finished uploading." });
    if (!created && row.video_media_id === mediaId) throw NOOP;
    await client.query(`update public.social_posts set video_media_id = $2 where event_date = $1::date`, [date, mediaId]);
    return {
      action: "social_post.video",
      details: { created, eventCreated, before: { video_media_id: row.video_media_id }, after: { video_media_id: mediaId } },
    };
  });
}

/** One channel's caption / first-comment overrides. */
export async function saveChannel(actorUserId, date, channel, input) {
  checkDate(date);
  const v = validateChannelInput(channel, input);
  return audited(actorUserId, date, "social_post_channels", async (client) => {
    const { eventCreated, created, row: post } = await lockPost(client, date);
    const { rows: [luma] } = await client.query(
      `select url from public.event_links where event_date = $1::date and platform = 'luma'`, [date]);
    // Text equal to the default is no override: the channel keeps following the default.
    const d0 = defaultTexts(channel, { baseCaption: post.base_caption, lumaUrl: luma?.url ?? null, extraHashtags: post.extra_hashtags });
    const after = {
      caption: v.caption === d0.caption ? null : v.caption,
      first_comment: v.firstComment === d0.firstComment ? null : v.firstComment,
    };
    const { rows: [row] } = await client.query(
      `select caption, first_comment from public.social_post_channels
        where event_date = $1::date and channel = $2 for update`, [date, channel]);
    const d = diff(row, after);
    if (!created && d.changed.length === 0) throw NOOP;
    if (post.ready) {
      const order = await stateIn(client, date, { channel: { channel, values: { caption: after.caption, firstComment: after.first_comment } } });
      const p = order.problems.find((x) => x.key === `caption_${channel}`);
      if (p) throw new ValidationError({ caption: p.message });
    }
    await client.query(
      `update public.social_post_channels set caption = $3, first_comment = $4
        where event_date = $1::date and channel = $2`, [date, channel, after.caption, after.first_comment]);
    return { action: "social_post_channel.update", details: { channel, created, eventCreated, before: d.before, after: d.after } };
  });
}
