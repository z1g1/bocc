// Social work order rules (ADR 0011 decision 2; plan Phase 5). Pure functions, NO
// imports, so the admin event page, the social role's pages and any scheduled check
// all apply exactly the same rules. The database side is ./social.mjs.
//
// Channel texts (defaultTexts, channelTexts). Luma is the only link ever used:
//   facebook, threads, linkedin_page   caption = base caption + "\n\nRSVP: <Luma URL>"
//                                      no first comment
//   instagram                          caption = base caption + "\n\nLink in bio"
//                                      first comment = "RSVP: <Luma URL>"
//   tiktok                             as instagram, then a blank line and the hashtags:
//                                      TIKTOK_HASHTAGS + the post's extra_hashtags
//   A channel's stored `caption` / `first_comment` (an admin override) replaces the
//   whole default text; NULL means "use the default".
//   With no Luma listing the texts carry LUMA_PLACEHOLDER and readyProblems() says so.
//
// Publish time (defaultPublishAt, easternToUtc): Monday 7:00 AM America/New_York
// strictly before the event date (a Tuesday event: the day before), DST-correct.
// Shown both in Eastern and in UTC (formatPublishAt).
//
// Ready (readyProblems, publishAtProblems): a post may be marked ready only with a
// ready promo video, a base caption, a Luma listing, every final caption within its
// channel's limit, an event that isn't cancelled, and a publish time that is in the
// future and not after the event day. buildWorkOrder() puts it all together.

/** Channels in work-order order (the Wednesday task's order), with their labels. */
export const CHANNELS = Object.freeze({
  facebook: "Facebook",
  instagram: "Instagram",
  threads: "Threads",
  tiktok: "TikTok",
  linkedin_page: "LinkedIn page",
});
export const CHANNEL_KEYS = Object.freeze(Object.keys(CHANNELS));
export const isChannel = (c) => typeof c === "string" && Object.hasOwn(CHANNELS, c);

/** Channel statuses (the column's CHECK): pending -> scheduled -> live | failed. */
export const STATUSES = Object.freeze(["pending", "scheduled", "live", "failed"]);

/** Channels whose caption carries the Luma link; the others say "Link in bio". */
export const LINK_CHANNELS = Object.freeze(["facebook", "threads", "linkedin_page"]);
/** Channels that get the Luma link as their first comment. */
export const COMMENT_CHANNELS = Object.freeze(["instagram", "tiktok"]);

export const LINK_IN_BIO = "Link in bio";
export const RSVP_PREFIX = "RSVP: ";
export const LUMA_PLACEHOLDER = "[Luma link: add the Luma listing]";

/** TikTok's default hashtags; extra_hashtags are added after them. */
export const TIKTOK_HASHTAGS = Object.freeze(["#Entrepreneurship", "#Startups", "#BuffaloBusiness", "#Networking"]);

/** Each platform's caption limit, in characters (code points, like Postgres length()). */
export const CAPTION_LIMITS = Object.freeze({
  facebook: 63206,
  instagram: 2200,
  threads: 500,
  tiktok: 2200,
  linkedin_page: 3000,
});

/** Field limits; keep in step with the CHECKs in migration 20261122120000_social_posts.sql. */
export const LIMITS = Object.freeze({
  baseCaption: 2000,
  coverNote: 500,
  extraHashtags: 10,
  hashtag: 50,
  caption: 5000,
  firstComment: 1000,
  notes: 2000,
  postUrl: 500,
});

export const PUBLISH_DEFAULT = Object.freeze({ weekday: "Monday", hour: 7, minute: 0 });

const TZ = "America/New_York";

// ── Hashtags ─────────────────────────────────────────────────────────────────

/**
 * Extra hashtags from a form field: words separated by spaces or commas, each with or
 * without its "#". Duplicates (also of TIKTOK_HASHTAGS, ignoring case) are dropped.
 * Throws Error(message) on a bad tag or too many.
 * @param {unknown} raw  a string, or an array of strings (from the database)
 * @returns {string[]}  e.g. ["#SmallBusiness"]
 */
export function normaliseHashtags(raw) {
  const words = Array.isArray(raw) ? raw.map(String) : (typeof raw === "string" ? raw : "").split(/[\s,]+/);
  const seen = new Set(TIKTOK_HASHTAGS.map((t) => t.toLowerCase()));
  const out = [];
  for (const w of words) {
    if (w === "") continue;
    const word = w.replace(/^#+/, "");
    if (!/^[\p{L}\p{N}_]+$/u.test(word)) throw new Error(`"${w.slice(0, 60)}" isn't a hashtag (letters, digits and _ only).`);
    if (word.length > LIMITS.hashtag) throw new Error(`A hashtag can be at most ${LIMITS.hashtag} characters.`);
    const tag = `#${word}`;
    if (seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  if (out.length > LIMITS.extraHashtags) throw new Error(`At most ${LIMITS.extraHashtags} extra hashtags.`);
  return out;
}

/** TikTok's full hashtag line. */
export const tiktokHashtags = (extra = []) => [...TIKTOK_HASHTAGS, ...extra].join(" ");

// ── Texts ────────────────────────────────────────────────────────────────────

/**
 * The code default caption and first comment for one channel.
 * @param {string} channel
 * @param {{ baseCaption: string|null, lumaUrl: string|null, extraHashtags?: string[] }} post
 * @returns {{ caption: string|null, firstComment: string|null }}  caption null = no base caption yet
 */
export function defaultTexts(channel, { baseCaption, lumaUrl, extraHashtags = [] }) {
  if (!isChannel(channel)) throw new Error(`defaultTexts: unknown channel "${channel}"`);
  const link = `${RSVP_PREFIX}${lumaUrl || LUMA_PLACEHOLDER}`;
  const base = typeof baseCaption === "string" && baseCaption.trim() !== "" ? baseCaption.trim() : null;
  if (LINK_CHANNELS.includes(channel)) {
    return { caption: base === null ? null : `${base}\n\n${link}`, firstComment: null };
  }
  const parts = base === null ? null : [base, LINK_IN_BIO];
  if (parts && channel === "tiktok") parts.push(tiktokHashtags(extraHashtags));
  return { caption: parts ? parts.join("\n\n") : null, firstComment: link };
}

/**
 * One channel's final texts: the override when set, else the default.
 * @param {string} channel
 * @param {{ baseCaption: string|null, lumaUrl: string|null, extraHashtags?: string[] }} post
 * @param {{ caption?: string|null, firstComment?: string|null }} [override]  the channel row
 */
export function channelTexts(channel, post, override = {}) {
  const d = defaultTexts(channel, post);
  const captionOverridden = typeof override.caption === "string" && override.caption !== "";
  const firstCommentOverridden = typeof override.firstComment === "string" && override.firstComment !== "";
  const caption = captionOverridden ? override.caption : d.caption;
  const captionLength = caption === null ? 0 : [...caption].length;
  return {
    caption,
    firstComment: firstCommentOverridden ? override.firstComment : d.firstComment,
    defaultCaption: d.caption,
    defaultFirstComment: d.firstComment,
    captionOverridden,
    firstCommentOverridden,
    captionLength,
    captionLimit: CAPTION_LIMITS[channel],
    overLimit: captionLength > CAPTION_LIMITS[channel],
  };
}

// ── Time ─────────────────────────────────────────────────────────────────────

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
const etFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
});

/** "YYYY-MM-DDTHH:MM" in Eastern (the value of an <input type="datetime-local">). */
export function easternLocal(date) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(date)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

const isYmd = (s) => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/**
 * An Eastern wall-clock time -> the instant. DST-correct: a time that doesn't exist
 * (the spring-forward hour) throws; one that happens twice (the fall-back hour) is the
 * first of the two (EDT).
 * @param {string} local  "YYYY-MM-DDTHH:MM" (seconds, if given, must be :00)
 * @returns {Date}
 */
export function easternToUtc(local) {
  const m = typeof local === "string" ? /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::00(?:\.0+)?)?$/.exec(local.trim()) : null;
  if (!m || !isYmd(m[1]) || Number(m[2]) > 23 || Number(m[3]) > 59) throw new Error("Enter a date and time.");
  const wanted = `${m[1]}T${m[2]}:${m[3]}`;
  const naive = Date.parse(`${wanted}:00Z`);
  // Eastern is UTC-4 (EDT) or UTC-5 (EST); the earlier instant first.
  const hits = [4, 5].map((h) => new Date(naive + h * 3600_000)).filter((d) => easternLocal(d) === wanted);
  if (hits.length === 0) throw new Error(`${wanted.replace("T", " ")} doesn't exist in Eastern time (the clocks skip that hour).`);
  return hits[0];
}

/** The Monday strictly before `eventDate` (YYYY-MM-DD). */
export function mondayBefore(eventDate) {
  if (!isYmd(eventDate)) throw new Error("mondayBefore: date must be YYYY-MM-DD");
  const d = new Date(`${eventDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (((d.getUTCDay() + 6) % 7) || 7));
  return d.toISOString().slice(0, 10);
}

/** Monday 7:00 AM Eastern before the event. */
export function defaultPublishAt(eventDate) {
  const hh = String(PUBLISH_DEFAULT.hour).padStart(2, "0");
  const mm = String(PUBLISH_DEFAULT.minute).padStart(2, "0");
  return easternToUtc(`${mondayBefore(eventDate)}T${hh}:${mm}`);
}

/**
 * @param {Date|string} date
 * @returns {{ et: string, utc: string, local: string, iso: string }}
 *   et "Mon, Nov 23, 2026, 7:00 AM EST"; utc "2026-11-23 12:00 UTC";
 *   local "2026-11-23T07:00" (Eastern, for the form); iso the full UTC ISO string
 */
export function formatPublishAt(date) {
  const d = new Date(date);
  const iso = d.toISOString();
  return { et: etFmt.format(d), utc: `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`, local: easternLocal(d), iso };
}

// ── Ready ────────────────────────────────────────────────────────────────────

/**
 * What stops a post being ready (empty = nothing). Checked when ready is switched on
 * and on every save of a ready post; the social role's pages show it too, since the
 * Luma listing can change afterwards.
 * @param {{ event: { status: string }, post: { baseCaption: string|null } | null,
 *           video: { kind: string, status: string } | null, lumaUrl: string|null,
 *           channels: Array<{ channel: string, caption: string|null, overLimit: boolean, captionLength: number, captionLimit: number }> }} s
 * @returns {Array<{ key: string, message: string }>}
 */
export function readyProblems({ event, post, video, lumaUrl, channels = [] }) {
  const out = [];
  if (event?.status === "cancelled") out.push({ key: "event", message: "The event is cancelled." });
  if (!video) out.push({ key: "video", message: "Upload the promo video." });
  else if (video.kind !== "promo_video" || video.status !== "ready") out.push({ key: "video", message: "The promo video hasn't finished uploading." });
  if (!post?.baseCaption) out.push({ key: "baseCaption", message: "Write the base caption." });
  if (!lumaUrl) out.push({ key: "luma", message: "Add the Luma listing (under Online Event Listings): it is the only link the posts use." });
  for (const c of channels) {
    if (c.overLimit) {
      out.push({ key: `caption_${c.channel}`, message: `The ${CHANNELS[c.channel]} caption is ${c.captionLength} characters; the limit is ${c.captionLimit}.` });
    }
  }
  return out;
}

/**
 * Problems with a publish time, checked when it changes or ready is switched on.
 * @param {Date} publishAt
 * @param {string} eventDate  YYYY-MM-DD
 * @param {Date} now
 * @returns {string|null}
 */
export function publishAtProblem(publishAt, eventDate, now = new Date()) {
  if (easternLocal(publishAt).slice(0, 10) > eventDate) return "The publish time is after the event.";
  if (publishAt.getTime() <= now.getTime()) return "The publish time has already passed.";
  return null;
}

// ── Cover image (ticket #22) ─────────────────────────────────────────────────

/**
 * The promo video's cover image. With no override it is the event's Event Image
 * (event-image-rules.mjs resolveEventImage: uploaded, referenced, or the BOCC logo);
 * an override is a publicly usable, ready `social_photo` (social_posts.cover_media_id).
 * An override that can't be used falls back to the Event Image. The cover is the
 * square/original file (video platforms crop their own covers), plus its thumbnail
 * for the admin page's preview. Files are { key, contentType } (private bucket) or
 * { path, contentType, width, height } (checked in under public/).
 * @param {{ override?: null | { id: string, eventDate: string, kind: string, status: string, publiclyUsable: boolean,
 *            originalKey: string, thumbKey: string, contentType: string },
 *           eventImage: { source: string, mediaId: string|null, eventDate: string|null, original: object, thumb: object } }} s
 * @returns {{ source: "override"|"event_image", eventImageSource: string|null, mediaId: string|null,
 *             eventDate: string|null, file: object, thumb: object }}
 */
export function resolveSocialCover({ override = null, eventImage }) {
  if (override && override.kind === "social_photo" && override.status === "ready" && override.publiclyUsable) {
    return {
      source: "override", eventImageSource: null, mediaId: override.id, eventDate: override.eventDate,
      file: { key: override.originalKey, contentType: override.contentType },
      thumb: { key: override.thumbKey, contentType: "image/jpeg" },
    };
  }
  return {
    source: "event_image", eventImageSource: eventImage.source, mediaId: eventImage.mediaId, eventDate: eventImage.eventDate,
    file: eventImage.original, thumb: eventImage.thumb,
  };
}

/**
 * The whole work order for one event, calculated (nothing here is stored).
 * @param {{ date: string, event: { status: string, exists?: boolean },
 *           post: null | { videoMediaId: string|null, coverNote: string|null, baseCaption: string|null,
 *                          extraHashtags: string[], publishAt: Date, ready: boolean, updatedAt?: Date,
 *                          channels: Record<string, { caption: string|null, firstComment: string|null, status: string,
 *                            postUrl: string|null, verifiedAt: Date|null, commentPostedAt: Date|null, notes: string|null }> },
 *           lumaUrl: string|null, video: null | { id: string, kind: string, status: string, contentType: string, sizeBytes: number },
 *           coverMedia?: object|null, eventImage?: object|null }} s
 *   coverMedia: the event_media row of post.coverMediaId (null = none); eventImage: the
 *   resolved Event Image. Both only feed `cover` (resolveSocialCover).
 */
export function buildWorkOrder({ date, event, post, lumaUrl, video, coverMedia = null, eventImage = null }) {
  const texts = { baseCaption: post?.baseCaption ?? null, lumaUrl, extraHashtags: post?.extraHashtags ?? [] };
  const channels = CHANNEL_KEYS.map((channel) => {
    const row = post?.channels?.[channel] ?? null;
    return {
      channel,
      label: CHANNELS[channel],
      status: row?.status ?? null,
      postUrl: row?.postUrl ?? null,
      verifiedAt: row?.verifiedAt ?? null,
      commentPostedAt: row?.commentPostedAt ?? null,
      notes: row?.notes ?? null,
      ...channelTexts(channel, texts, { caption: row?.caption ?? null, firstComment: row?.firstComment ?? null }),
    };
  });
  const publishAt = post?.publishAt ? new Date(post.publishAt) : defaultPublishAt(date);
  const problems = readyProblems({ event, post, video, lumaUrl, channels });
  const ready = Boolean(post?.ready);
  return {
    date,
    exists: Boolean(post),
    eventStatus: event?.status ?? "scheduled",
    ready,
    problems,
    /** Ready and nothing wrong: the Chrome tasks may act on it. */
    actionable: ready && problems.length === 0,
    publishAt,
    publishAtDisplay: formatPublishAt(publishAt),
    publishAtIsDefault: publishAt.getTime() === defaultPublishAt(date).getTime(),
    coverNote: post?.coverNote ?? null,
    baseCaption: post?.baseCaption ?? null,
    extraHashtags: post?.extraHashtags ?? [],
    tiktokHashtags: tiktokHashtags(post?.extraHashtags ?? []),
    lumaUrl,
    video,
    /** resolveSocialCover(); null only when the caller passed no Event Image. Never a ready problem. */
    cover: eventImage ? resolveSocialCover({ override: coverMedia, eventImage }) : null,
    updatedAt: post?.updatedAt ?? null,
    channels,
  };
}

// ── Channel results (the social role's pages, Phase 5 part B) ────────────────

/**
 * Status changes setChannelResult() (./social.mjs) accepts. The happy path is
 * pending -> scheduled (Wednesday) -> live | failed (Monday). Every other change is
 * there to fix a mistake: back to pending (not scheduled after all), failed -> any
 * (retried), live -> scheduled (marked live too early), and pending -> live (it went
 * out but Wednesday's save was missed). Refused: live -> pending (a published post
 * can't be unscheduled; mark it failed with a note instead). Saving the same status
 * again is always allowed (to change the URL or notes).
 */
export const TRANSITIONS = Object.freeze({
  pending: Object.freeze(["scheduled", "live", "failed"]),
  scheduled: Object.freeze(["pending", "live", "failed"]),
  live: Object.freeze(["scheduled", "failed"]),
  failed: Object.freeze(["pending", "scheduled", "live"]),
});

/** @returns {boolean} */
export const canTransition = (from, to) => from === to || Boolean(TRANSITIONS[from]?.includes(to));

/** Where each channel's posts live: a post URL's host must be one of these or a subdomain. */
export const POST_URL_DOMAINS = Object.freeze({
  facebook: Object.freeze(["facebook.com", "fb.com"]),
  instagram: Object.freeze(["instagram.com"]),
  threads: Object.freeze(["threads.com", "threads.net"]),
  tiktok: Object.freeze(["tiktok.com"]),
  linkedin_page: Object.freeze(["linkedin.com"]),
});

/**
 * Why `url` can't be this channel's post URL, or null when it can: https, no spaces,
 * no user name or port, at most LIMITS.postUrl characters, on the channel's domain.
 * @param {string} channel
 * @param {string} url  already trimmed
 * @returns {string|null}
 */
export function postUrlProblem(channel, url) {
  if (!isChannel(channel)) return "Unknown channel.";
  const domains = POST_URL_DOMAINS[channel];
  const where = `an https link on ${domains.join(" or ")}`;
  if (typeof url !== "string" || url === "") return `Enter the ${CHANNELS[channel]} post URL.`;
  if ([...url].length > LIMITS.postUrl) return `At most ${LIMITS.postUrl} characters.`;
  if (/\s/.test(url) || !/^https:\/\//i.test(url)) return `The ${CHANNELS[channel]} post URL must be ${where}.`;
  let u;
  try { u = new URL(url); } catch { return `The ${CHANNELS[channel]} post URL must be ${where}.`; }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || u.username || u.password || u.port
      || !domains.some((d) => host === d || host.endsWith(`.${d}`))) {
    return `The ${CHANNELS[channel]} post URL must be ${where}.`;
  }
  return null;
}
