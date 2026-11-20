// Event readiness (./event-readiness.mjs) for several Events at once: the tags on the
// events list and the admin home page (src/components/admin/ReadyTag.astro). Reads the
// Listings in one query and, per date, the LinkedIn follow-up (its ledger row and Event
// Image, for drift and a cancellation due). Admin only: the CALLER checks the role.

import { linksByDate } from "./event-links.mjs";
import { eventReadiness } from "./event-readiness.mjs";
import { linkedInFollowUpFor } from "../linkedin/linkedin.mjs";

/**
 * @param {{ query: Function }} db
 * @param {Array<{ date: string, status: string, location: string|null, cancelAnnounced: boolean }>} events
 *   events.mjs listUpcoming rows
 * @returns {Promise<Map<string, ReturnType<typeof eventReadiness>>>} by date
 */
export async function eventReadinessByDate(db, events) {
  const links = await linksByDate(db, events.map((e) => e.date));
  const linkedIn = await Promise.all(events.map((e) => linkedInFollowUpFor(db, e.date, { event: e })));
  return new Map(events.map((e, n) => [e.date, eventReadiness(e, links.get(e.date), { linkedIn: linkedIn[n] })]));
}
