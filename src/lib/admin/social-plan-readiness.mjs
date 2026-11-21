// Social plan readiness (#59, GLOSSARY "Social plan readiness"): where an Event's Social
// plan stands. Calculated, never stored. Pure: it imports only social-plan-rules.mjs.
// Shown under Event readiness at the top of the Admin event page.
//
//   Social plan: <Plan status>, or "No Social plan yet"
//     problems  what keeps it from Ready for Posting (readyProblems), hidden once Posted
//     posts     each social media post with its Post status
//   Ticked only when Posted, or Ready for Posting with no problems; Error and To do never are.

import { DONE_POST_STATUSES, postStatusLabel } from "./social-plan-rules.mjs";

/**
 * @typedef {{ key: string, label: string, ok: boolean }} Item
 * @param {null | { exists: boolean, status: string, statusLabel: string,
 *   problems: Array<{ message: string }>, channels: Array<{ channel: string, label: string, status: string|null }> }} plan
 *   social-plan.mjs getWorkOrder; null = none
 * @returns {{ exists: boolean, status: string|null, label: string, ok: boolean,
 *   problems: Item[], posts: Item[], scheduled: number, total: number }}
 */
export function socialPlanReadiness(plan) {
  if (!plan?.exists) {
    return { exists: false, status: null, label: "No Social plan yet", ok: false, problems: [], posts: [], scheduled: 0, total: 0 };
  }
  const { status } = plan;
  const problems = status === "posted" ? []
    : (plan.problems ?? []).map((p, n) => ({ key: `problem_${n}`, label: p.message, ok: false }));
  const posts = (plan.channels ?? []).map((c) => {
    const s = c.status ?? "pending";
    return { key: `post_${c.channel}`, label: `${c.label}: ${postStatusLabel(s)}`, ok: DONE_POST_STATUSES.includes(s) };
  });
  return {
    exists: true, status,
    label: `Social plan: ${plan.statusLabel}`,
    ok: status === "posted" || (status === "ready" && (plan.problems ?? []).length === 0),
    problems, posts,
    scheduled: posts.filter((p) => p.ok).length,
    total: posts.length,
  };
}
