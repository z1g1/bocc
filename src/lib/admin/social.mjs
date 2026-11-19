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
//   setChannelResult(actor, date, channel, input, { now })   social_post_channel.result
//       What the Chrome tasks write back (the social role's /admin/social/* pages and
//       POST /api/admin/social/channel). Never creates a post (404 without one).
//       input: status (pending|scheduled|live|failed; absent = keep), postUrl and notes
//       (absent = keep; "" or null = clear; any other non-string is a 400), verified
//       (true: stamp verified_at again on a live post), commentPosted (true: stamp comment_posted_at, false: clear it).
//       Rules: the changes in TRANSITIONS (social-rules.mjs; only live -> pending is
//       refused, 409); moving INTO scheduled needs an actionable post (ready, no
//       problems; 409); live needs a post URL; failed needs a note; a post URL must
//       be https on the channel's domain (postUrlProblem) and is stored as parsed
//       (new URL().href: "HTTPS://WWW.Facebook.com/x" -> "https://www.facebook.com/x").
//       The post row is held FOR SHARE for the whole change. Becoming live stamps
//       verified_at; leaving live clears it. The first comment exists only on
//       Instagram and TikTok (COMMENT_CHANNELS) and can be marked posted only while
//       the channel is live.
// Returns { changed, eventCreated }: the caller purges the public page only when the
// events row was created (nothing here shows on the public page).
//
// The social role's pages pick their post with:
//   findNext(db, { now, today })    the EARLIEST upcoming event (event_date >= today
//       Eastern; every Tuesday counts, with or without an events row; cancelled ones
//       don't, and neither does a Tuesday in the holiday break, Dec 22 to Jan 4, unless
//       it has a scheduled row: ../holiday-weeks.mjs) whose publish time (the default one without a post) is still ahead and
//       that still has work: no post, not ready, or a channel pending. It never skips
//       a stuck week for a later one; a week moves on once none of its channels is
//       pending. { state: "ready", order } when that post is actionable, otherwise
//       { state: "nothing", reason, message, date, problems, upcoming } with reason
//       no_post | not_ready | problems, about that same week.
//   findVerify(db, { now, today })  the post (of an event that isn't cancelled) whose
//       publish_at passed most recently, up to and including its event day (a post
//       always has its events row, so a holiday-week post is the override and counts):
//       { state: "verify", order, todo, allDone } or { state: "nothing", message, nextPublish }.
//
// Errors: ValidationError (400; .errors is { field: message }), ConflictError (409)
// from ./events.mjs, NotFoundError (404) from here.

import { withAudit } from "./db.mjs";
import { ConflictError, nextTuesday, parseDate, todayEastern, ValidationError } from "./events.mjs";
import { isUuid } from "./attendees.mjs";
import { isHolidayWeek } from "../holiday-weeks.mjs";
import { getEventImage } from "./event-image.mjs";
import {
  CHANNELS, CHANNEL_KEYS, COMMENT_CHANNELS, LIMITS, STATUSES, TRANSITIONS, buildWorkOrder, canTransition,
  defaultPublishAt, defaultTexts, easternToUtc, isChannel, normaliseHashtags, postUrlProblem, publishAtProblem,
} from "./social-rules.mjs";

export * from "./social-rules.mjs";

const POST_COLUMNS = `
  p.event_date::text   as date,
  p.video_media_id     as "videoMediaId",
  p.cover_media_id     as "coverMediaId",
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
  const [{ rows: [event] }, { rows: [luma] }, post, eventImage] = await Promise.all([
    db.query(`select status from public.events where event_date = $1::date`, [date]),
    db.query(`select url from public.event_links where event_date = $1::date and platform = 'luma'`, [date]),
    getSocialPost(db, date),
    getEventImage(db, date),
  ]);
  const [video, coverMedia] = await Promise.all([
    post?.videoMediaId ? getVideo(db, post.videoMediaId) : null,
    post?.coverMediaId ? getCoverMedia(db, post.coverMediaId) : null,
  ]);
  return {
    event: event ? { status: event.status, exists: true } : { status: "scheduled", exists: false },
    post,
    lumaUrl: luma?.url ?? null,
    video,
    coverMedia,
    eventImage,
  };
}

const COVER_COLUMNS = `
  id, event_date::text as "eventDate", kind, status, publicly_usable as "publiclyUsable",
  original_key as "originalKey", thumb_key as "thumbKey", content_type as "contentType"`;

async function getCoverMedia(db, id) {
  const { rows: [m] } = await db.query(`select ${COVER_COLUMNS} from public.event_media where id = $1`, [id]);
  return m ?? null;
}

/** How many recent event dates' photos the cover picker offers. */
export const COVER_CHOICE_DATES = 8;

/**
 * Photos the Social Post cover can be set to: ready, publicly usable Photos from Event
 * of this event and the most recent earlier dates with any (COVER_CHOICE_DATES dates
 * in all), newest first. { id, eventDate, thumbKey, contentType }.
 */
export async function listCoverChoices(db, date) {
  requireDate(date, "listCoverChoices");
  const { rows } = await db.query(
    `with dates as (
       select distinct event_date from public.event_media
        where kind = 'social_photo' and status = 'ready' and publicly_usable and event_date <= $1::date
        order by event_date desc limit $2)
     select m.id, m.event_date::text as "eventDate", m.thumb_key as "thumbKey", m.content_type as "contentType"
       from public.event_media m join dates using (event_date)
      where m.kind = 'social_photo' and m.status = 'ready' and m.publicly_usable
      order by m.event_date desc, m.created_at desc, m.id`, [date, COVER_CHOICE_DATES]);
  return rows;
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

export class NotFoundError extends ValidationError {
  status = 404;
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
    `select video_media_id, cover_media_id, cover_note, base_caption, extra_hashtags, publish_at, ready
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

/**
 * Override the promo video's cover with a ready, publicly usable Photo from Event (of
 * any event), or clear it ("" / null) so the cover is the Event Image again.
 */
export async function setCover(actorUserId, date, mediaId) {
  checkDate(date);
  const clearing = mediaId === "" || mediaId == null;
  if (!clearing && !isUuid(mediaId)) throw new ValidationError({ cover: "Choose a photo." });
  return audited(actorUserId, date, "social_posts", async (client) => {
    const { eventCreated, created, row } = await lockPost(client, date);
    const before = row.cover_media_id ?? null;
    const after = clearing ? null : mediaId;
    if (!clearing) {
      const { rows: [m] } = await client.query(
        `select kind, status, publicly_usable from public.event_media where id = $1 for share`, [mediaId]);
      if (!m || m.kind !== "social_photo" || !m.publicly_usable) throw new ValidationError({ cover: "That isn't a Photo from Event." });
      if (m.status !== "ready") throw new ValidationError({ cover: "That photo hasn't finished uploading." });
    }
    // Nothing to change. Clearing with no post rolls back the post's creation too.
    if (before === after && (clearing || !created)) throw NOOP;
    await client.query(`update public.social_posts set cover_media_id = $2 where event_date = $1::date`, [date, after]);
    return {
      action: "social_post.cover",
      details: { created, eventCreated, before: { cover_media_id: before }, after: { cover_media_id: after } },
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

// ── Channel results ──────────────────────────────────────────────────────────

const has = (o, k) => o != null && Object.hasOwn(o, k) && o[k] !== undefined;
/** A text field that may be null (= clear) or a string; anything else (123, {}, []) is refused. */
const textOrNull = (v) => v === null || typeof v === "string";
const flag = (v) => {
  if (typeof v === "boolean") return v;
  if (v !== null && typeof v !== "string") return null;
  const t = str(v).trim().toLowerCase();
  if (["on", "true", "1", "yes"].includes(t)) return true;
  if (["off", "false", "0", "no", ""].includes(t)) return false;
  return null;
};

/**
 * The input of setChannelResult(), checked on its own (before any database work).
 * @returns {{ status?: string, postUrl?: string|null, notes?: string|null, verified: boolean, commentPosted?: boolean }}
 */
export function validateResultInput(channel, input) {
  if (!isChannel(channel)) throw new ValidationError({ channel: "Unknown channel." });
  const errors = {};
  const out = { verified: false };
  if (has(input, "status")) {
    const st = typeof input.status === "string" ? input.status.trim() : null;
    if (!STATUSES.includes(st)) errors.status = `Status must be one of ${STATUSES.join(", ")}.`;
    else out.status = st;
  }
  if (has(input, "postUrl")) {
    if (!textOrNull(input.postUrl)) errors.postUrl = "postUrl must be a string (or null / \"\" to clear it).";
    else {
      let u = text(input.postUrl);
      if (u !== null) {
        let p = postUrlProblem(channel, u);
        // Store the parsed form (lower-case scheme and host, spaces encoded): the
        // column's CHECK is a case-sensitive '^https://'. Checked again as stored.
        if (!p) { u = new URL(u).href; p = postUrlProblem(channel, u); }
        if (p) errors.postUrl = p;
      }
      out.postUrl = u;
    }
  }
  if (has(input, "notes")) {
    if (!textOrNull(input.notes)) errors.notes = "notes must be a string (or null / \"\" to clear them).";
    else {
      const n = text(input.notes);
      if (n !== null && len(n) > LIMITS.notes) errors.notes = `At most ${LIMITS.notes} characters.`;
      out.notes = n;
    }
  }
  if (has(input, "verified")) {
    const f = flag(input.verified);
    if (f === null) errors.verified = "verified must be true or false.";
    else out.verified = f;
  }
  if (has(input, "commentPosted")) {
    const f = flag(input.commentPosted);
    if (f === null) errors.commentPosted = "commentPosted must be true or false.";
    else if (!COMMENT_CHANNELS.includes(channel)) {
      errors.commentPosted = `${CHANNELS[channel]} has no first comment (only ${COMMENT_CHANNELS.map((c) => CHANNELS[c]).join(" and ")} do).`;
    } else out.commentPosted = f;
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
  return out;
}

/** Record what happened on one channel (see the header). */
export async function setChannelResult(actorUserId, date, channel, input, { now = new Date() } = {}) {
  checkDate(date);
  const v = validateResultInput(channel, input);
  return audited(actorUserId, date, "social_post_channels", async (client) => {
    // The post first, then the channel: the same order as lockPost() (the admin's
    // writes, which hold the post FOR UPDATE), so the two can't deadlock. FOR SHARE
    // keeps the post (ready, caption, video, publish time) from changing under the
    // `actionable` check below until this commits; channel saves don't block each other.
    const { rowCount: hasPost } = await client.query(
      `select 1 from public.social_posts where event_date = $1::date for share`, [date]);
    if (!hasPost) throw new NotFoundError({ date: `There is no social post for ${date}.` });
    const { rows: [row] } = await client.query(
      `select status, post_url, notes, verified_at, comment_posted_at
         from public.social_post_channels
        where event_date = $1::date and channel = $2
          for update`, [date, channel]);
    if (!row) throw new NotFoundError({ date: `There is no social post for ${date}.` });
    const label = CHANNELS[channel];
    const status = v.status ?? row.status;
    if (!canTransition(row.status, status)) {
      throw new ConflictError({
        status: `${label} is ${row.status}; it can't go back to ${status}. From ${row.status} it can become ${TRANSITIONS[row.status].join(", ")}.`,
      });
    }
    const after = {
      status,
      post_url: "postUrl" in v ? v.postUrl : row.post_url,
      notes: "notes" in v ? v.notes : row.notes,
      verified_at: row.verified_at,
      comment_posted_at: row.comment_posted_at,
    };
    if (status === "live" && !after.post_url) throw new ValidationError({ postUrl: `A live post needs its ${label} post URL.` });
    if (status === "failed" && row.status !== "failed" && !after.notes) {
      throw new ValidationError({ notes: `Say in the notes why ${label} failed.` });
    }
    if (status === "live" && (row.status !== "live" || v.verified)) after.verified_at = now;
    else if (status !== "live") {
      if (v.verified) throw new ValidationError({ verified: `Only a live post can be marked verified; ${label} is ${status}.` });
      after.verified_at = null;
    }
    if (v.commentPosted === true) {
      if (status !== "live") throw new ValidationError({ commentPosted: `Mark ${label} live before its first comment.` });
      if (!row.comment_posted_at) after.comment_posted_at = now;
    } else if (v.commentPosted === false) after.comment_posted_at = null;

    const d = diff(row, after);
    if (d.changed.length === 0) throw NOOP;
    if (status === "scheduled" && row.status !== "scheduled") {
      const order = await getWorkOrder(client, date);
      if (!order.actionable) {
        const why = order.ready ? order.problems.map((p) => p.message).join(" ") : "The post isn't marked ready.";
        throw new ConflictError({ status: `Can't schedule ${label} yet: ${why}` });
      }
    }
    await client.query(
      `update public.social_post_channels
          set status = $3, post_url = $4, notes = $5, verified_at = $6, comment_posted_at = $7
        where event_date = $1::date and channel = $2`,
      [date, channel, after.status, after.post_url, after.notes, after.verified_at, after.comment_posted_at]);
    return { action: "social_post_channel.result", details: { channel, before: d.before, after: d.after } };
  });
}

// ── The social role's picks ──────────────────────────────────────────────────

const addDays = (date, n) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** The post for the Wednesday task (see the header). */
export async function findNext(db, { now = new Date(), today = todayEastern(now) } = {}) {
  // Every upcoming events row with its post (a post always has its events row:
  // lockPost creates it). Rows are made on demand, so a Tuesday without one is still
  // an event (scheduled, no post yet), EXCEPT in the holiday break (Dec 22 to Jan 4,
  // ../holiday-weeks.mjs): a holiday Tuesday without a row doesn't exist and is
  // skipped like a cancelled one. A row always counts (unless cancelled), holiday or
  // not: a scheduled row on a holiday date is the deliberate override for an unusual
  // year. Skipping only ever drops a holiday Tuesday, so the earliest NORMAL week with
  // work is still never skipped for a later one.
  const { rows } = await db.query(
    `select e.event_date::text as date, e.status, p.event_date is not null as "hasPost", p.ready,
            p.publish_at as "publishAt",
            (select count(*)::int from public.social_post_channels c
              where c.event_date = e.event_date and c.status = 'pending') as pending
       from public.events e
       left join public.social_posts p on p.event_date = e.event_date
      where e.event_date >= $1::date
      order by e.event_date`, [today]);
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const first = nextTuesday(today);
  const last = rows.length && rows.at(-1).date > first ? rows.at(-1).date : first;
  const dates = new Set(rows.map((r) => r.date));
  for (let d = first; d <= last; d = addDays(d, 7)) if (!isHolidayWeek(d)) dates.add(d);
  const events = [...dates].sort().map((d) => byDate.get(d) ?? { date: d, status: "scheduled", hasPost: false })
    .filter((r) => r.status !== "cancelled");

  // Still open for scheduling: its publish time (the default one without a post) ahead.
  const open = (r) => (r.hasPost ? new Date(r.publishAt) : defaultPublishAt(r.date)).getTime() > now.getTime();
  const upcoming = events.filter((r) => r.hasPost && open(r)).slice(0, 10)
    .map((r) => ({ date: r.date, ready: r.ready, pendingChannels: r.pending }));
  // The EARLIEST open event with work left (no post, not ready, or a channel still
  // pending). A later week is never handed out while this one is stuck; once every
  // channel of it is done (scheduled, live or failed), the next week's turn comes.
  let target = events.find((r) => open(r) && (!r.hasPost || !r.ready || r.pending > 0));
  if (!target) {
    // Every listed week is done or past its publish time: the first Tuesday after them
    // (nextTuesday skips the holiday break; so does this loop).
    let d = nextTuesday(addDays(last, 1));
    while (isHolidayWeek(d) || defaultPublishAt(d).getTime() <= now.getTime()) d = addDays(d, 7);
    target = { date: d, hasPost: false };
  }
  const wait = "Later weeks wait until this one is scheduled.";
  const base = { state: "nothing", date: target.date, upcoming };
  if (!target.hasPost) {
    return {
      ...base, reason: "no_post", problems: [],
      message: `No social post is set up for ${target.date} yet. ${wait}`,
    };
  }
  const order = await getWorkOrder(db, target.date);
  if (order.actionable) return { state: "ready", order };
  if (!order.ready) {
    return { ...base, reason: "not_ready", problems: order.problems, message: `The social post for ${target.date} isn't marked ready yet. ${wait}` };
  }
  return {
    ...base, reason: "problems", problems: order.problems,
    message: `The social post for ${target.date} is marked ready, but something needs fixing first. ${wait}`,
  };
}

/** What the Monday task still has to do on each channel of `order`. */
export function verifyTodo(order) {
  const todo = [];
  for (const c of order.channels) {
    if (c.status === "scheduled") todo.push({ channel: c.channel, task: "verify", message: `Open the ${c.label} post and mark it live or failed.` });
    else if (c.status === "pending" || c.status === null) todo.push({ channel: c.channel, task: "never_scheduled", message: `${c.label} was never marked scheduled: check whether it went out, then mark it live (with its URL) or failed.` });
    else if (c.status === "live" && COMMENT_CHANNELS.includes(c.channel) && !c.commentPostedAt) {
      todo.push({ channel: c.channel, task: "comment", message: `Post the first comment on ${c.label}, then mark it posted.` });
    }
  }
  return todo;
}

/** The post for the Monday task (see the header). */
export async function findVerify(db, { now = new Date(), today = todayEastern(now) } = {}) {
  const { rows: [r] } = await db.query(
    `select p.event_date::text as date from public.social_posts p
       join public.events e on e.event_date = p.event_date
      where p.publish_at <= $2 and p.event_date >= $1::date and e.status <> 'cancelled'
      order by p.publish_at desc, p.event_date desc limit 1`, [today, now]);
  if (!r) {
    const { rows: [n] } = await db.query(
      `select p.event_date::text as date, p.publish_at as "publishAt" from public.social_posts p
         join public.events e on e.event_date = p.event_date
        where p.publish_at > $2 and p.event_date >= $1::date and e.status <> 'cancelled'
        order by p.publish_at limit 1`, [today, now]);
    return {
      state: "nothing",
      message: "Nothing to verify: no social post's publish time has passed for an event that is still ahead (or today).",
      nextPublish: n ? { date: n.date, publishAt: n.publishAt } : null,
    };
  }
  const order = await getWorkOrder(db, r.date);
  const todo = verifyTodo(order);
  return { state: "verify", order, todo, allDone: todo.length === 0 };
}
