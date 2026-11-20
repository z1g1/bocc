// Phase 5 social work order rules (ADR 0011 decision 2), src/lib/admin/social-rules.mjs:
// pure functions, no database. Channel texts and overrides, TikTok hashtags, the
// Monday 7:00 AM Eastern default (DST), Eastern <-> UTC, what blocks `ready`, the
// work order, and the readiness checklist's social lines (event-links-rules.mjs).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as r from "../../src/lib/admin/social-rules.mjs";
import { readiness } from "../../src/lib/admin/event-links-rules.mjs";
import * as lib from "../../public/js/admin-media-lib.js";
import { DEFAULT_EVENT_IMAGE, resolveEventImage } from "../../src/lib/admin/event-image-rules.mjs";

const LUMA = "https://luma.com/abc123";
const post = (over = {}) => ({ baseCaption: "Coffee and founders, Tuesday 8 AM.", lumaUrl: LUMA, extraHashtags: [], ...over });

describe("channel texts", () => {
  test("Facebook, Threads and the LinkedIn page: caption + the Luma link, no first comment", () => {
    for (const c of ["facebook", "threads", "linkedin_page"]) {
      assert.deepEqual(r.defaultTexts(c, post()), {
        caption: `Coffee and founders, Tuesday 8 AM.\n\nRSVP: ${LUMA}`, firstComment: null,
      }, c);
    }
  });

  test("Instagram: Link in bio, the Luma link as the first comment", () => {
    assert.deepEqual(r.defaultTexts("instagram", post()), {
      caption: "Coffee and founders, Tuesday 8 AM.\n\nLink in bio", firstComment: `RSVP: ${LUMA}`,
    });
  });

  test("TikTok: as Instagram, plus the default hashtags and the extra ones", () => {
    const t = r.defaultTexts("tiktok", post({ extraHashtags: ["#Founders", "#Coffee"] }));
    assert.equal(t.caption, `Coffee and founders, Tuesday 8 AM.\n\nLink in bio\n\n${r.TIKTOK_HASHTAGS.join(" ")} #Founders #Coffee`);
    assert.equal(t.firstComment, `RSVP: ${LUMA}`);
    assert.ok(r.TIKTOK_HASHTAGS.length > 0 && r.TIKTOK_HASHTAGS.every((h) => /^#\w+$/.test(h)));
    // Extra hashtags are TikTok's only.
    assert.ok(!r.defaultTexts("instagram", post({ extraHashtags: ["#Founders"] })).caption.includes("#"));
  });

  test("Luma is the only link; without it the texts carry a placeholder", () => {
    for (const c of r.CHANNEL_KEYS) {
      const t = r.defaultTexts(c, post());
      const urls = `${t.caption} ${t.firstComment ?? ""}`.match(/https:\/\/\S+/g);
      assert.deepEqual([...new Set(urls)], [LUMA], c);
    }
    const none = r.defaultTexts("facebook", post({ lumaUrl: null }));
    assert.ok(none.caption.endsWith(`RSVP: ${r.LUMA_PLACEHOLDER}`));
  });

  test("no base caption: no caption yet (the first comment still has its default)", () => {
    assert.deepEqual(r.defaultTexts("instagram", post({ baseCaption: "   " })), { caption: null, firstComment: `RSVP: ${LUMA}` });
    assert.equal(r.defaultTexts("facebook", post({ baseCaption: null })).caption, null);
  });

  test("an override replaces the whole text; empty or null means the default", () => {
    const o = r.channelTexts("instagram", post(), { caption: "Custom IG text", firstComment: "Custom comment" });
    assert.deepEqual([o.caption, o.firstComment, o.captionOverridden, o.firstCommentOverridden], ["Custom IG text", "Custom comment", true, true]);
    assert.equal(o.defaultCaption, "Coffee and founders, Tuesday 8 AM.\n\nLink in bio");
    for (const over of [{}, { caption: null, firstComment: null }, { caption: "", firstComment: "" }]) {
      const d = r.channelTexts("instagram", post(), over);
      assert.deepEqual([d.caption, d.captionOverridden, d.firstCommentOverridden], [d.defaultCaption, false, false]);
    }
  });

  test("caption limits per channel (Threads 500)", () => {
    const long = "x".repeat(480);
    const threads = r.channelTexts("threads", post({ baseCaption: long }));
    assert.equal(threads.captionLimit, 500);
    assert.equal(threads.overLimit, true);
    assert.equal(threads.captionLength, 480 + 2 + "RSVP: ".length + LUMA.length);
    assert.equal(r.channelTexts("facebook", post({ baseCaption: long })).overLimit, false);
    // Code points, not UTF-16 units: an emoji is one character.
    assert.equal(r.channelTexts("threads", post(), { caption: "☕️🙂" }).captionLength, 3);
    assert.throws(() => r.defaultTexts("myspace", post()), /unknown channel/);
  });
});

describe("hashtags", () => {
  test("with or without #, spaces or commas; duplicates and the defaults dropped", () => {
    assert.deepEqual(r.normaliseHashtags("SmallBusiness, #founders  #Founders,,#networking #Café_2"), ["#SmallBusiness", "#founders", "#Café_2"]);
    assert.deepEqual(r.normaliseHashtags(""), []);
    assert.deepEqual(r.normaliseHashtags(undefined), []);
    assert.deepEqual(r.normaliseHashtags(["#A", "B"]), ["#A", "#B"]);
  });
  test("refused: punctuation, too long, too many", () => {
    for (const bad of ["#no-dash", "#a.b", "<script>", "#🙂"]) assert.throws(() => r.normaliseHashtags(bad), /isn't a hashtag/, bad);
    assert.throws(() => r.normaliseHashtags(`#${"a".repeat(51)}`), /at most 50/);
    assert.throws(() => r.normaliseHashtags(Array.from({ length: 11 }, (_, i) => `#t${i}`).join(" ")), /At most 10/);
  });
});

describe("publish time", () => {
  test("the Monday strictly before the event", () => {
    assert.equal(r.mondayBefore("2026-11-24"), "2026-11-23"); // Tuesday
    assert.equal(r.mondayBefore("2026-11-23"), "2026-11-16"); // a Monday event: the week before
    assert.equal(r.mondayBefore("2026-11-29"), "2026-11-23"); // Sunday
    assert.equal(r.mondayBefore("2026-11-26"), "2026-11-23"); // Thursday
    assert.equal(r.mondayBefore("2027-01-05"), "2027-01-04"); // across the year
    assert.throws(() => r.mondayBefore("2026-02-30"), /YYYY-MM-DD/);
  });

  test("default is 7:00 AM Eastern, DST-correct", () => {
    const iso = (d) => r.defaultPublishAt(d).toISOString();
    assert.equal(iso("2026-11-24"), "2026-11-23T12:00:00.000Z"); // EST
    assert.equal(iso("2026-07-14"), "2026-07-13T11:00:00.000Z"); // EDT
    assert.equal(iso("2026-03-10"), "2026-03-09T11:00:00.000Z"); // the day after spring forward (Mar 8)
    assert.equal(iso("2026-03-03"), "2026-03-02T12:00:00.000Z"); // the week before: still EST
    assert.equal(iso("2026-11-03"), "2026-11-02T12:00:00.000Z"); // the day after fall back (Nov 1)
    assert.equal(iso("2026-10-27"), "2026-10-26T11:00:00.000Z"); // the week before: still EDT
  });

  test("the default's hint names the rule and that Monday's date, across DST (#41)", () => {
    assert.equal(r.publishAtDefaultHint("2026-11-24"), "the Monday before the event, 7:00 AM Eastern (Mon, Nov 23)");
    assert.equal(r.publishAtDefaultHint("2026-11-03"), "the Monday before the event, 7:00 AM Eastern (Mon, Nov 2)", "the day after clocks fall back");
    assert.equal(r.publishAtDefaultHint("2026-03-10"), "the Monday before the event, 7:00 AM Eastern (Mon, Mar 9)", "the day after clocks spring forward");
    assert.equal(r.publishAtDefaultHint("2027-01-05"), "the Monday before the event, 7:00 AM Eastern (Mon, Jan 4)");
  });

  test("Eastern wall clock -> UTC: skipped hour refused, repeated hour is the first (EDT)", () => {
    assert.equal(r.easternToUtc("2026-11-23T07:00").toISOString(), "2026-11-23T12:00:00.000Z");
    assert.equal(r.easternToUtc("2026-06-01T23:59").toISOString(), "2026-06-02T03:59:00.000Z");
    assert.equal(r.easternToUtc("2026-11-01T01:30").toISOString(), "2026-11-01T05:30:00.000Z");
    assert.equal(r.easternToUtc("2026-11-01T01:30:00").toISOString(), "2026-11-01T05:30:00.000Z");
    assert.throws(() => r.easternToUtc("2026-03-08T02:30"), /doesn't exist in Eastern time/);
    for (const bad of ["", "2026-11-23", "2026-11-23 07:00", "2026-02-30T07:00", "2026-11-23T24:00", "2026-11-23T07:60", "2026-11-23T07:00Z", null]) {
      assert.throws(() => r.easternToUtc(bad), /Enter a date and time/, String(bad));
    }
  });

  test("shown in Eastern and UTC, and as the form's local value", () => {
    assert.deepEqual(r.formatPublishAt(new Date("2026-11-23T12:00:00Z")), {
      et: "Mon, Nov 23, 2026, 7:00 AM EST", utc: "2026-11-23 12:00 UTC", local: "2026-11-23T07:00", iso: "2026-11-23T12:00:00.000Z",
    });
    assert.equal(r.formatPublishAt(new Date("2026-07-13T11:00:00Z")).et, "Mon, Jul 13, 2026, 7:00 AM EDT");
    // Round trip through the form value.
    for (const d of ["2026-11-23T12:00:00.000Z", "2026-03-09T11:00:00.000Z"]) {
      assert.equal(r.easternToUtc(r.formatPublishAt(new Date(d)).local).toISOString(), d);
    }
  });

  test("publish time problems: after the event day, or already passed", () => {
    const now = new Date("2026-11-18T15:00:00Z");
    assert.equal(r.publishAtProblem(new Date("2026-11-23T12:00:00Z"), "2026-11-24", now), null);
    // The event day itself (Eastern) is allowed; 11 PM ET on the event day still is.
    assert.equal(r.publishAtProblem(new Date("2026-11-25T04:00:00Z"), "2026-11-24", now), null);
    assert.match(r.publishAtProblem(new Date("2026-11-25T05:00:00Z"), "2026-11-24", now), /after the event/);
    assert.match(r.publishAtProblem(new Date("2026-11-18T15:00:00Z"), "2026-11-24", now), /already passed/);
  });
});

describe("ready and the work order", () => {
  const video = { id: "v1", kind: "promo_video", status: "ready", contentType: "video/mp4", sizeBytes: 5_000_000 };
  const stored = (over = {}) => ({
    videoMediaId: "v1", coverNote: "Frame at 0:03", baseCaption: "Coffee!", extraHashtags: ["#Founders"],
    publishAt: new Date("2026-11-23T12:00:00Z"), status: "ready",
    channels: Object.fromEntries(r.CHANNEL_KEYS.map((c) => [c, {
      caption: null, firstComment: null, status: "pending", postUrl: null, verifiedAt: null, commentPostedAt: null, notes: null,
    }])),
    ...over,
  });

  test("everything in place: actionable, with every channel's final text", () => {
    const w = r.buildWorkOrder({ date: "2026-11-24", event: { status: "scheduled" }, post: stored(), lumaUrl: LUMA, video });
    assert.deepEqual([w.exists, w.ready, w.problems, w.actionable, w.publishAtIsDefault], [true, true, [], true, true]);
    assert.deepEqual(w.channels.map((c) => c.channel), ["facebook", "instagram", "threads", "tiktok", "linkedin_page"]);
    assert.equal(w.channels[0].caption, `Coffee!\n\nRSVP: ${LUMA}`);
    assert.equal(w.channels[3].firstComment, `RSVP: ${LUMA}`);
    assert.ok(w.channels[3].caption.endsWith("#Founders"));
    assert.equal(w.publishAtDisplay.utc, "2026-11-23 12:00 UTC");
    assert.equal(w.tiktokHashtags, `${r.TIKTOK_HASHTAGS.join(" ")} #Founders`);
  });

  test("not actionable without video, caption, Luma; cancelled; over a limit; or not marked ready", () => {
    const keys = (s) => r.buildWorkOrder({ date: "2026-11-24", event: { status: "scheduled" }, post: stored(), lumaUrl: LUMA, video, ...s })
      .problems.map((p) => p.key);
    assert.deepEqual(keys({ video: null }), ["video"]);
    assert.deepEqual(keys({ video: { ...video, status: "pending" } }), ["video"]);
    assert.deepEqual(keys({ video: { ...video, kind: "social_photo" } }), ["video"]);
    assert.deepEqual(keys({ post: stored({ baseCaption: null }) }), ["baseCaption"]);
    assert.deepEqual(keys({ lumaUrl: null }), ["luma"]);
    assert.deepEqual(keys({ event: { status: "cancelled" } }), ["event"]);
    assert.deepEqual(keys({ post: stored({ baseCaption: "y".repeat(495) }) }), ["caption_threads"]);
    const notReady = r.buildWorkOrder({ date: "2026-11-24", event: { status: "scheduled" }, post: stored({ status: "todo" }), lumaUrl: LUMA, video });
    assert.deepEqual([notReady.problems, notReady.actionable], [[], false]);
    const msgs = r.readyProblems({ event: { status: "scheduled" }, post: null, video: null, lumaUrl: null }).map((p) => p.message);
    assert.deepEqual(msgs, ["Upload the promo video.", "Write the base caption.", "Add the Luma listing (under Online Event Listings): it is the only link the posts use."]);
  });

  test("a date with no post: defaults, not actionable", () => {
    const w = r.buildWorkOrder({ date: "2026-11-24", event: { status: "scheduled", exists: false }, post: null, lumaUrl: null, video: null });
    assert.deepEqual([w.exists, w.ready, w.actionable, w.publishAt.toISOString()], [false, false, false, "2026-11-23T12:00:00.000Z"]);
    assert.ok(w.channels.every((c) => c.status === null && c.caption === null));
  });

  test("Readiness: Social Posts: <status>, or not set up yet; the problems and channels under it", () => {
    const ev = { date: "2026-11-24", status: "scheduled" };
    const none = readiness(ev, {});
    assert.deepEqual([none.social.label, none.social.ok, none.social.items], ["Social Posts: not set up yet", false, []]);

    const p = stored();
    p.channels.facebook.status = "scheduled";
    p.channels.instagram.status = "live";
    p.channels.tiktok.status = "failed";
    const at = (status, post = p, lumaUrl = LUMA) =>
      readiness(ev, {}, r.buildWorkOrder({ date: ev.date, event: ev, post: { ...post, status }, lumaUrl, video })).social;
    assert.deepEqual(["todo", "ready", "posted", "error"].map((s) => at(s).label),
      ["Social Posts: To do", "Social Posts: Ready for Posting", "Social Posts: Posted", "Social Posts: Error"]);
    const ready = at("ready");
    assert.deepEqual(ready.items.map((i) => [i.key, i.label, i.ok]), [
      ["social_facebook", "Facebook: scheduled", true],
      ["social_instagram", "Instagram: live", true],
      ["social_threads", "Threads: pending", false],
      ["social_tiktok", "TikTok: failed", false],
      ["social_linkedin_page", "LinkedIn page: pending", false],
    ]);
    assert.deepEqual([ready.ok, ready.scheduled, ready.total], [true, 2, 5]);
    assert.equal(at("todo").ok, false);
    // A tick only for Posted, or Ready for Posting with no problems: never Error or To do.
    assert.equal(at("error").ok, false, "Error is never ticked");
    assert.equal(at("error", stored()).ok, false, "Error with no problems is still not ticked");
    assert.equal(at("ready", stored(), null).ok, false, "Ready for Posting with a problem");
    // The problems are listed (no "not marked ready" line any more)...
    const noLuma = at("todo", stored(), null);
    assert.match(noLuma.items[0].label, /Luma listing/);
    assert.ok(!JSON.stringify(noLuma).includes("not marked ready"));
    // ...but not once Posted: a Posted post is done.
    const posted = at("posted", stored(), null);
    assert.equal(posted.ok, true);
    assert.ok(posted.items.every((i) => i.key.startsWith("social_") && !i.key.startsWith("social_problem")), "channels only");
  });
});

describe("the Social Post cover image", () => {
  const video = { id: "v1", kind: "promo_video", status: "ready", contentType: "video/mp4", sizeBytes: 5_000_000 };
  const uploaded = resolveEventImage({ uploaded: {
    id: "11111111-1111-4111-8111-111111111111", eventDate: "2026-11-24", kind: "event_image", status: "ready",
    originalKey: "events/2026-11-24/1111/original.png", displayKey: "events/2026-11-24/1111/display.jpg",
    thumbKey: "events/2026-11-24/1111/thumb.jpg", image16x9Key: "events/2026-11-24/1111/cover.jpg", contentType: "image/png",
  } });
  const photo = {
    id: "22222222-2222-4222-8222-222222222222", eventDate: "2026-11-17", kind: "social_photo", status: "ready",
    publiclyUsable: true, originalKey: "events/2026-11-17/2222/original.jpg", displayKey: "events/2026-11-17/2222/display.jpg",
    thumbKey: "events/2026-11-17/2222/thumb.jpg", contentType: "image/jpeg",
  };

  test("no override: the Event Image, which may be the logo default", () => {
    const c = r.resolveSocialCover({ override: null, eventImage: DEFAULT_EVENT_IMAGE });
    assert.deepEqual(c, {
      source: "event_image", eventImageSource: "default", mediaId: null, eventDate: null,
      file: { path: "/assets/images/brand/bocc-logo-square.png", contentType: "image/png", width: 2000, height: 2000 },
      thumb: { path: "/assets/images/brand/bocc-logo-square.png", contentType: "image/png", width: 2000, height: 2000 },
    });
    const u = r.resolveSocialCover({ override: null, eventImage: uploaded });
    assert.deepEqual([u.source, u.eventImageSource, u.mediaId, u.file, u.thumb], ["event_image", "uploaded",
      "11111111-1111-4111-8111-111111111111", { key: "events/2026-11-24/1111/display.jpg", contentType: "image/jpeg" },
      { key: "events/2026-11-24/1111/thumb.jpg", contentType: "image/jpeg" }]);
  });

  test("an override: that photo's display copy", () => {
    const c = r.resolveSocialCover({ override: photo, eventImage: uploaded });
    assert.deepEqual(c, {
      source: "override", eventImageSource: null, mediaId: "22222222-2222-4222-8222-222222222222", eventDate: "2026-11-17",
      file: { key: "events/2026-11-17/2222/display.jpg", contentType: "image/jpeg" },
      thumb: { key: "events/2026-11-17/2222/thumb.jpg", contentType: "image/jpeg" },
    });
  });

  test("an override that can't be used (not ready, not publicly usable, not a photo) falls back to the Event Image", () => {
    for (const bad of [{ status: "pending" }, { publiclyUsable: false }, { kind: "signin_board" }]) {
      assert.equal(r.resolveSocialCover({ override: { ...photo, ...bad }, eventImage: uploaded }).source, "event_image");
    }
  });

  test("the work order carries the cover; the cover never changes what blocks ready", () => {
    const post = {
      videoMediaId: "v1", coverMediaId: photo.id, coverNote: null, baseCaption: "Coffee!", extraHashtags: [],
      publishAt: new Date("2026-11-23T12:00:00Z"), status: "ready", channels: {},
    };
    const base = { date: "2026-11-24", event: { status: "scheduled" }, post, lumaUrl: LUMA, video };
    const w = r.buildWorkOrder({ ...base, coverMedia: photo, eventImage: uploaded });
    assert.equal(w.cover.source, "override");
    assert.deepEqual([w.problems, w.actionable], [[], true]);
    const d = r.buildWorkOrder({ ...base, coverMedia: null, eventImage: DEFAULT_EVENT_IMAGE });
    assert.equal(d.cover.eventImageSource, "default");
    assert.deepEqual(r.buildWorkOrder({ ...base, video: null, eventImage: uploaded }).problems.map((p) => p.key), ["video"]);
  });
});

describe("the post status (ticket #39)", () => {
  const video = { id: "v1", kind: "promo_video", status: "ready", contentType: "video/mp4", sizeBytes: 5_000_000 };
  const stored = (status, statuses = {}) => ({
    videoMediaId: "v1", coverNote: null, baseCaption: "Coffee!", extraHashtags: [],
    publishAt: new Date("2026-11-23T12:00:00Z"), status,
    channels: Object.fromEntries(r.CHANNEL_KEYS.map((c) => [c, {
      caption: null, firstComment: null, status: statuses[c] ?? "pending", postUrl: null, verifiedAt: null, commentPostedAt: null, notes: null,
    }])),
  });
  const order = (status, over = {}) =>
    r.buildWorkOrder({ date: "2026-11-24", event: { status: "scheduled" }, post: stored(status), lumaUrl: LUMA, video, ...over });

  test("four statuses, in dropdown order, with their labels", () => {
    assert.deepEqual(r.POST_STATUSES, ["todo", "ready", "posted", "error"]);
    assert.deepEqual(r.POST_STATUSES.map((s) => r.POST_STATUS_LABELS[s]), ["To do", "Ready for Posting", "Posted", "Error"]);
    assert.equal(r.isPostStatus("posted"), true);
    assert.equal(r.isPostStatus("on"), false);
    assert.equal(r.isPostStatus(undefined), false);
  });

  test("the work order: Ready for Posting (and Error, to finish or retry its channels) is offered; To do and Posted aren't", () => {
    assert.deepEqual(r.POST_STATUSES.map((s) => [s, order(s).status, order(s).statusLabel, order(s).actionable]), [
      ["todo", "todo", "To do", false],
      ["ready", "ready", "Ready for Posting", true],
      ["posted", "posted", "Posted", false],
      ["error", "error", "Error", true],
    ]);
    assert.equal(order("ready", { lumaUrl: null }).actionable, false);
    const none = r.buildWorkOrder({ date: "2026-11-24", event: { status: "scheduled" }, post: null, lumaUrl: null, video: null });
    assert.deepEqual([none.status, none.statusLabel, none.actionable], ["todo", "To do", false]);
  });

  test("a channel update: Error when it records failed, Posted when every channel is scheduled or live", () => {
    const all = (st, over = {}) => Object.fromEntries(r.CHANNEL_KEYS.map((c) => [c, over[c] ?? st]));
    const auto = (status, changedTo, channels) => r.postStatusAfterChannelUpdate({ status, changedTo, channels });
    // Still pending somewhere: no change.
    assert.equal(auto("ready", "scheduled", all("pending", { facebook: "scheduled" })), null);
    // The last one scheduled (live counts too).
    assert.equal(auto("ready", "scheduled", all("scheduled", { instagram: "live" })), "posted");
    assert.equal(auto("todo", "live", all("live")), "posted");
    // Failed: Error, whatever the others are.
    assert.equal(auto("ready", "failed", all("pending", { facebook: "failed" })), "error");
    assert.equal(auto("posted", "failed", all("live", { tiktok: "failed" })), "error");
    // A failed channel retried: Posted once nothing is failed or pending.
    assert.equal(auto("error", "scheduled", all("scheduled")), "posted");
    assert.equal(auto("error", "scheduled", all("scheduled", { tiktok: "failed" })), null);
    // Already there, or the channel's status didn't change: nothing to do.
    assert.equal(auto("posted", "live", all("live")), null);
    assert.equal(auto("error", "failed", all("failed")), null);
    assert.equal(auto("ready", null, all("scheduled")), null);
  });
});

describe("browser video checks", () => {
  test("MP4 and MOV by MIME type, within the limit", () => {
    assert.deepEqual(lib.checkVideoFile({ type: "video/mp4", size: 5_000_000 }), { ok: true, contentType: "video/mp4" });
    assert.deepEqual(lib.checkVideoFile({ type: "video/quicktime", size: 1 }), { ok: true, contentType: "video/quicktime" });
    assert.match(lib.checkVideoFile({ type: "video/webm", size: 10, name: "a.webm" }).message, /^a\.webm: only MP4 or MOV/);
    assert.match(lib.checkVideoFile({ type: "image/jpeg", size: 10 }).message, /only MP4 or MOV/);
    assert.match(lib.checkVideoFile({ type: "video/mp4", size: 0 }).message, /empty/);
    assert.match(lib.checkVideoFile({ type: "video/mp4", size: lib.MAX_VIDEO_BYTES + 1 }).message, /limit is 100\.0 MB/);
    assert.deepEqual(lib.videoUploadRequestBody({ eventDate: "2026-11-24", original: { contentType: "video/mp4", size: 9, name: "x" } }),
      { eventDate: "2026-11-24", kind: "promo_video", original: { contentType: "video/mp4", size: 9 } });
  });
});
