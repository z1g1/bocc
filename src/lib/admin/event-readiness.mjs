// Event readiness (#59, GLOSSARY "Event readiness"): is an Upcoming Event, or today's,
// ready to be found and attended? Calculated, never stored. Pure: it imports only the
// pure Listing rules (event-links-rules.mjs). Shown at the top of the Admin event page
// (src/pages/admin/events/[date].astro) and, as a tag, in the events list and on the
// admin home page (src/components/admin/ReadyTag.astro).
//
// A Scheduled Event (any status but cancelled; an unsaved date counts, with no Location):
//   Listings x/5     required: Luma, Eventbrite, Facebook, LinkedIn and the Public event
//                    page. The LinkedIn Listing is done once its URL is saved: the app
//                    saves it when its LinkedIn post is out; a URL saved with no posted
//                    LinkedIn event in the app was made outside the app (a caution line).
//                    "LinkedIn is out of date" (drift) is listed under it and blocks it.
//   Location         required, explicitly set: "not set (Lobby assumed)" until chosen
//                    (the Public event page and the Listings use the Lobby meanwhile).
//   Event Image      information only: Default (BOCC logo) or Custom.
// A Cancelled Event:
//   Cancellation     required: "Announced on all socials" ticked, and no LinkedIn
//                    cancellation due. No Listings, no Location.

import { PLATFORM_KEYS, PLATFORMS, LISTINGS_TOTAL, hasPublicPage, publicPageExists, publicPath } from "./event-links-rules.mjs";
import { LINKEDIN_SECTION_HREF } from "../linkedin/rules.mjs";

/** Location labels. The source is events.mjs LOCATIONS (not imported: it needs the database). Keep in step. */
const LOCATION_LABELS = { lobby: "Lobby", food_hall: "Food hall", other: "Other" };

/**
 * @typedef {{ key: string, label: string, ok: boolean, caution?: true, note?: string, href?: string }} Item
 *   href: a link; caution: done, with a caveat in the note (shown ⚠, not ✓)
 * @typedef {{ key: string, label: string, ok: boolean, info?: true, items: Item[] }} Bullet
 *   info: information only (no tick or cross, never blocks readiness)
 *
 * @param {{ date: string, status: string, exists?: boolean, location?: string|null,
 *   locationOther?: string|null, cancelAnnounced?: boolean }} event  events.mjs getEvent, or a listUpcoming row
 * @param {Record<string, { url: string } | null | undefined>} [links]  by platform (event-links.mjs getLinks)
 * @param {{ eventImage?: { source: string },
 *   linkedIn?: { eventUrl?: string|null, drift: null | { message: string, href: string },
 *     cancel: null | { due: boolean, message: string, href: string } } }} [extra]
 *   eventImage: the resolved Event Image (event-image-rules.mjs); linkedIn: linkedin/rules.mjs linkedInFollowUp
 * @returns {{ kind: "scheduled"|"cancelled", ok: boolean, publicHref?: string, bullets: Bullet[],
 *   tag: { label: string, ok: boolean } }}
 */
export function eventReadiness(event, links = {}, { eventImage, linkedIn } = {}) {
  const publicHref = publicPageExists(event) ? publicPath(event.date) : undefined;
  return event.status === "cancelled"
    ? cancelledReadiness(event, linkedIn, publicHref)
    : scheduledReadiness(event, links, { eventImage, linkedIn }, publicHref);
}

const result = (kind, bullets, publicHref, missing) => {
  const ok = bullets.every((b) => b.info || b.ok);
  return { kind, ok, publicHref, bullets, tag: { label: ok ? "Ready" : missing.join(" · "), ok } };
};

function cancelledReadiness(event, linkedIn, publicHref) {
  const announced = Boolean(event.cancelAnnounced);
  const items = linkedIn?.cancel?.due ? [{ key: "linkedin_cancel", label: linkedIn.cancel.message, ok: false, href: linkedIn.cancel.href }] : [];
  const bullets = [{
    key: "cancellation",
    label: `Cancellation: ${announced ? "announced on all socials" : "not announced on all socials yet"}`,
    ok: announced && items.length === 0,
    items,
  }];
  return result("cancelled", bullets, publicHref, [
    ...(announced ? [] : ["Cancellation not announced"]),
    ...(items.length ? ["Cancel on LinkedIn"] : []),
  ]);
}

function scheduledReadiness(event, links, { eventImage, linkedIn }, publicHref) {
  const bullets = [];
  const parts = PLATFORM_KEYS.map((p) => ({ key: p, label: `${PLATFORMS[p]} listing`, ok: Boolean(links[p]?.url) }));
  parts.push({
    key: "public_page", label: "Public event page", ok: hasPublicPage(event), href: publicHref,
    note: !publicPageExists(event) ? "a 404 until the event is saved (any save creates it)" : undefined,
  });
  if (linkedIn) {
    const li = parts.find((i) => i.key === "linkedin_event");
    const listed = links.linkedin_event?.url;
    if (!listed) Object.assign(li, { note: "not posted yet (LinkedIn event, Event Info tab)", href: LINKEDIN_SECTION_HREF });
    // Made outside the app (by hand, or the bocc-linkedin-event skill) and pasted into the
    // Listings: done, but the app has no posted LinkedIn event, so no drift or cancel follow-up.
    else if (!linkedIn.eventUrl) {
      Object.assign(li, { caution: true, href: listed, note: "created manually outside the app, so Location, Event Image and cancel changes aren't tracked" });
    }
  }
  const done = parts.filter((i) => i.ok).length;
  const items = parts.filter((i) => !i.ok || i.caution);
  if (linkedIn?.drift) items.push({ key: "linkedin_drift", label: linkedIn.drift.message, ok: false, href: linkedIn.drift.href });
  bullets.push({ key: "listings", label: `Listings ${done}/${LISTINGS_TOTAL}`, ok: done === LISTINGS_TOTAL && !items.some((i) => !i.ok), items });

  const loc = event.location ?? null;
  const where = loc === null ? "not set (Lobby assumed)"
    : loc === "other" ? `Other${event.locationOther ? ` (${event.locationOther})` : ""}` : LOCATION_LABELS[loc] ?? loc;
  bullets.push({ key: "location", label: `Location: ${where}`, ok: loc !== null, items: [] });
  if (eventImage) {
    bullets.push({ key: "event_image", label: `Event Image: ${eventImage.source === "default" ? "Default (BOCC logo)" : "Custom"}`, ok: true, info: true, items: [] });
  }
  return result("scheduled", bullets, publicHref, [
    ...(done < LISTINGS_TOTAL ? [`${done}/${LISTINGS_TOTAL} listings`] : []),
    ...(loc === null ? ["Location not set"] : []),
    ...(linkedIn?.drift ? ["LinkedIn out of date"] : []),
  ]);
}
