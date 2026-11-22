// Social plan readiness (#59, GLOSSARY "Social plan readiness"), pure: no database.
//   node --test tests/admin/social-plan-readiness-unit.test.mjs
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { socialPlanReadiness } from "../../src/lib/admin/social-plan-readiness.mjs";
import * as r from "../../src/lib/admin/social-plan-rules.mjs";

const DATE = "2026-11-24";
const EVENT = { date: DATE, status: "scheduled" };
const LUMA = "https://luma.com/abc";
const video = { id: "v1", kind: "promo_video", status: "ready", contentType: "video/mp4", sizeBytes: 1000 };
const channelRow = (status = "pending") => ({ caption: null, firstComment: null, status, postUrl: null, verifiedAt: null, commentPostedAt: null, notes: null });
const plan = (status, chans = {}) => ({
  videoMediaId: "v1", coverNote: null, baseCaption: "Coffee Tuesday", extraHashtags: [], publishAt: new Date("2026-11-23T12:00:00Z"), status,
  channels: Object.fromEntries(r.CHANNEL_KEYS.map((c) => [c, channelRow(chans[c])])),
});
const workOrder = (plan, { lumaUrl = LUMA } = {}) => r.buildWorkOrder({ date: DATE, event: EVENT, plan, lumaUrl, video: plan ? video : null });

describe("Social plan readiness", () => {
  test("no Social plan yet: says so, nothing under it", () => {
    for (const wo of [null, workOrder(null)]) {
      const s = socialPlanReadiness(wo);
      assert.deepEqual([s.exists, s.label, s.ok, s.problems, s.posts], [false, "No Social plan yet", false, [], []]);
    }
  });

  test("each Plan status as the label", () => {
    assert.deepEqual(["todo", "ready", "posted", "error"].map((st) => socialPlanReadiness(workOrder(plan(st))).label),
      ["Social plan: To do", "Social plan: Ready for Posting", "Social plan: Posted", "Social plan: Error"]);
  });

  test("each social media post with its Post status", () => {
    const s = socialPlanReadiness(workOrder(plan("ready", { facebook: "scheduled", instagram: "live", tiktok: "failed" })));
    assert.deepEqual(s.posts.map((i) => [i.key, i.label, i.ok]), [
      ["post_facebook", "Facebook: Scheduled", true],
      ["post_instagram", "Instagram: Live", true],
      ["post_threads", "Threads: Pending", false],
      ["post_tiktok", "TikTok: Failed", false],
      ["post_linkedin_page", "LinkedIn page: Pending", false],
    ]);
    assert.deepEqual([s.scheduled, s.total], [2, 5]);
  });

  test("the problems blocking Ready for Posting, hidden once Posted", () => {
    const missing = { ...plan("todo"), baseCaption: null };
    const todo = socialPlanReadiness(workOrder(missing, { lumaUrl: null }));
    assert.deepEqual(todo.problems.map((p) => [p.label, p.ok]), [
      ["Write the base caption.", false],
      ["Add the Luma listing (under Online Event Listings): it is the only link the posts use.", false],
    ]);
    assert.equal(todo.ok, false);
    assert.deepEqual(socialPlanReadiness(workOrder({ ...missing, status: "posted" }, { lumaUrl: null })).problems, [], "hidden once Posted");
  });

  test("a tick only for Posted, or Ready for Posting with no problems", () => {
    const ok = (post, opts) => socialPlanReadiness(workOrder(post, opts)).ok;
    assert.equal(ok(plan("posted")), true);
    assert.equal(ok(plan("ready")), true);
    assert.equal(ok({ ...plan("ready"), baseCaption: null }), false);
    assert.equal(ok(plan("todo")), false);
    assert.equal(ok(plan("error")), false);
  });
});
