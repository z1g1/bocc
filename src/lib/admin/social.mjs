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
//       (absent = keep, blank = clear), verified (true: stamp verified_at again on a
//       live post), commentPosted (true: stamp comment_posted_at, false: clear it).
//       Rules: the changes in TRANSITIONS (social-rules.mjs; only live -> pending is
//       refused, 409); moving INTO scheduled needs an actionable post (ready, no
//       problems; 409); live needs a post URL; failed needs a note; a post URL must
//       be https on the channel's domain (postUrlProblem). Becoming live stamps
//       verified_at; leaving live clears it. The first comment exists only on
//       Instagram and TikTok (COMMENT_CHANNELS) and can be marked posted only while
//       the channel is live.
// Returns { changed, eventCreated }: the caller purges the public page only when the
// events row was created (nothing here shows on the public page).
//
// The social role's pages pick their post with:
//   findNext(db, { now, today })    the next upcoming post (event_date >= today Eastern,
//       publish_at still ahead) that is actionable and has a pending channel:
//       { state: "ready", order } or { state: "nothing", reason, message, date,
//       problems, upcoming } with reason no_post | not_ready | problems | all_done.
//   findVerify(db, { now, today })  the post whose publish_at passed most recently,
//       up to and including its event day: { state: "verify", order, todo, allDone }
//       or { state: "nothing", message, nextPublish }.
//
// Errors: ValidationError (400; .errors is { field: message }), ConflictError (409)
// from ./events.mjs, NotFoundError (404) from here.

import { withAudit } from "./db.mjs";
import { ConflictError, nextTuesday, parseDate, todayEastern, ValidationError } from "./events.mjs";
import { isUuid } from "./attendees.mjs";
import {
  CHANNELS, CHANNEL_KEYS, COMMENT_CHANNELS, LIMITS, STATUSES, TRANSITIONS, buildWorkOrder, canTransition,
  defaultPublishAt, defaultTexts, easternToUtc, isChannel, normaliseHashtags, postUrlProblem, publishAtProblem,
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

// ── Channel results ──────────────────────────────────────────────────────────

const has = (o, k) => o != null && Object.hasOwn(o, k) && o[k] !== undefined;
const flag = (v) => {
  if (typeof v === "boolean") return v;
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
    const st = str(input.status).trim();
    if (!STATUSES.includes(st)) errors.status = `Status must be one of ${STATUSES.join(", ")}.`;
    else out.status = st;
  }
  if (has(input, "postUrl")) {
    const u = text(input.postUrl);
    if (u !== null) {
      const p = postUrlProblem(channel, u);
      if (p) errors.postUrl = p;
    }
    out.postUrl = u;
  }
  if (has(input, "notes")) {
    const n = text(input.notes);
    if (n !== null && len(n) > LIMITS.notes) errors.notes = `At most ${LIMITS.notes} characters.`;
    out.notes = n;
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
    const { rows: [row] } = await client.query(
      `select c.status, c.post_url, c.notes, c.verified_at, c.comment_posted_at
         from public.social_post_channels c
         join public.social_posts p on p.event_date = c.event_date
        where c.event_date = $1::date and c.channel = $2
          for update of c`, [date, channel]);
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

/** The next post for the Wednesday task (see the header). */
export async function findNext(db, { now = new Date(), today = todayEastern(now) } = {}) {
  const { rows } = await db.query(
    `select p.event_date::text as date, p.ready, p.publish_at as "publishAt",
            (select count(*)::int from public.social_post_channels c
              where c.event_date = p.event_date and c.status = 'pending') as pending
       from public.social_posts p
      where p.event_date >= $1::date and p.publish_at > $2
      order by p.event_date
      limit 10`, [today, now]);
  for (const r of rows) {
    if (!r.ready || r.pending === 0) continue;
    const order = await getWorkOrder(db, r.date);
    if (order.actionable) return { state: "ready", order };
  }
  const upcoming = rows.map((r) => ({ date: r.date, ready: r.ready, pendingChannels: r.pending }));
  const first = rows[0];
  if (!first) {
    const { rows: [ev] } = await db.query(
      `select event_date::text as date from public.events
        where event_date >= $1::date and status <> 'cancelled' order by event_date limit 1`, [today]);
    const date = ev?.date ?? nextTuesday(today);
    return {
      state: "nothing", reason: "no_post", date, problems: [], upcoming,
      message: `No social post is set up for ${date} (or any later event) yet.`,
    };
  }
  const order = await getWorkOrder(db, first.date);
  const base = { state: "nothing", date: first.date, problems: order.problems, upcoming };
  if (!order.ready) return { ...base, reason: "not_ready", message: `The social post for ${first.date} isn't marked ready yet.` };
  if (order.problems.length) return { ...base, reason: "problems", message: `The social post for ${first.date} is marked ready, but something needs fixing first.` };
  return { ...base, reason: "all_done", message: `Every channel for ${first.date} is already done (none is pending).` };
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
    `select event_date::text as date from public.social_posts
      where publish_at <= $2 and event_date >= $1::date
      order by publish_at desc, event_date desc limit 1`, [today, now]);
  if (!r) {
    const { rows: [n] } = await db.query(
      `select event_date::text as date, publish_at as "publishAt" from public.social_posts
        where publish_at > $2 and event_date >= $1::date order by publish_at limit 1`, [today, now]);
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
