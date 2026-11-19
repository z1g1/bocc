// Pure LinkedIn rules (ADR 0012). No database, no network, no imports, so unit tests
// and the browser-free Thursday check can load it. Later tickets add the event payload
// building, the allowed-actions matrix and drift detection here.

const DAY_MS = 86_400_000;

/** Days left under which the connection shows amber (red once expired). */
export const EXPIRY_WARNING_DAYS = 7;

/** The OAuth scopes the CLI used; the web flow asks for the same (ADR 0012 decision 4). */
export const SCOPES = Object.freeze(["r_events", "rw_events", "openid", "profile", "w_member_social"]);

/** LinkedIn's page where a member revokes the app's access. */
export const PERMITTED_SERVICES_URL = "https://www.linkedin.com/psettings/permitted-services";

/**
 * How close a connection is to expiry.
 * @param {Date|string|number} expiresAt
 * @param {Date} [now]
 * @returns {{ level: "ok"|"amber"|"red", daysLeft: number }}  daysLeft in whole days, 0 once expired
 */
export function expiryLevel(expiresAt, now = new Date()) {
  const left = new Date(expiresAt).getTime() - now.getTime();
  if (!(left > 0)) return { level: "red", daysLeft: 0 };
  return { level: left < EXPIRY_WARNING_DAYS * DAY_MS ? "amber" : "ok", daysLeft: Math.floor(left / DAY_MS) };
}

/**
 * The requested scopes missing from LinkedIn's grant (comma- or space-separated).
 * @param {string|undefined|null} granted
 * @returns {string[]}
 */
export function missingScopes(granted) {
  const have = new Set(String(granted ?? "").split(/[\s,]+/).filter(Boolean));
  return SCOPES.filter((s) => !have.has(s));
}

// ── The weekly event (issue #25) ───────────────────────────────────────────────
// Facts carried over from the CLI (tools/linkedin-events/bocc_events/config.py).

export const ORGANIZER_URN = "urn:li:organization:89993057";
export const EVENT_TZ = "America/New_York";
export const EXTERNAL_URL = "https://luma.com/716coffeeclub";
export const EVENT_ADDRESS = Object.freeze({
  line1: "1 Seneca St", city: "Buffalo", geographicArea: "New York", postalCode: "14203", country: "US",
});
const START = { h: 7, m: 30 };
const END = { h: 9, m: 0 };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, 22nd, 23rd, 31st. */
function ordinal(n) {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : ({ 1: "st", 2: "nd", 3: "rd" })[n % 10] ?? "th";
  return `${n}${suffix}`;
}

const parts = (date) => date.split("-").map(Number);

/** "Buffalo Open Coffee Club for October 6th" (decision on #25: month name, ordinal day). */
export function eventName(date) {
  const [, m, d] = parts(date);
  return `Buffalo Open Coffee Club for ${MONTHS[m - 1]} ${ordinal(d)}`;
}

/** The CLI's name for the same date, "Buffalo Open Coffee Club for 10/6" (duplicate check only). */
export function legacyEventName(date) {
  const [, m, d] = parts(date);
  return `Buffalo Open Coffee Club for ${m}/${d}`;
}

const tzParts = new Intl.DateTimeFormat("en-US", {
  timeZone: EVENT_TZ, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
});

/** Minutes the Eastern wall clock differs from UTC at instant `ms` (-240 in EDT, -300 in EST). */
function offsetMinutes(ms) {
  const p = Object.fromEntries(tzParts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return Math.round((wall - Math.floor(ms / 60_000) * 60_000) / 60_000);
}

/** The UTC instant of an Eastern wall-clock time on `date` (7:30 and 9:00 never fall in a DST gap). */
function easternInstant(date, { h, m }) {
  const [y, mo, d] = parts(date);
  const wall = Date.UTC(y, mo - 1, d, h, m);
  return wall - offsetMinutes(wall - offsetMinutes(wall) * 60_000) * 60_000;
}

/** @returns {{ startsAt: number, endsAt: number }} epoch ms (LinkedIn takes no time zone field) */
export function eventWindow(date) {
  return { startsAt: easternInstant(date, START), endsAt: easternInstant(date, END) };
}

const ymdEastern = new Intl.DateTimeFormat("en-CA", { timeZone: EVENT_TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** The Eastern calendar day (YYYY-MM-DD) of an instant. */
export function easternDay(ms) {
  return ymdEastern.format(new Date(ms));
}

/** The long form of a date as the name uses it: "October 6th". */
const monthDay = (date) => eventName(date).replace("Buffalo Open Coffee Club for ", "");

// Wording by location (config.py). `other` has no wording yet (#17): refused.
const NORMAL = {
  description: (date) => `Join us on ${monthDay(date)} for Buffalo Open Coffee Club, Your First Free Entrepreneurial Step in Buffalo. `
    + "A free, no-frills coffee meetup for the people building & running businesses in the 716.",
  venueDetails: "BOCC is right in the lobby, please come up the escalators",
  commentary: "Please join me at Buffalo Open Coffee Club",
};
const FOOD_HALL_TEXT = "Please join me at Buffalo Open Coffee Club. This week the event will be in the Seneca One Food hall vs our normal lobby location";
const FOOD_HALL = {
  description: () => FOOD_HALL_TEXT,
  venueDetails: "This week BOCC is in the Seneca One Food hall, not the lobby",
  commentary: FOOD_HALL_TEXT,
};

/** Every reason the app refuses a LinkedIn action: code -> the page's message. */
export const REFUSALS = Object.freeze({
  past: "The event date has passed: LinkedIn events can only be created for upcoming dates.",
  cancelled: "This event is cancelled. Un-cancel it before creating the LinkedIn event.",
  location_other: 'The location is "Other": there is no LinkedIn wording for it yet, so the app won\'t publish directions. Set Lobby or Food hall.',
  no_connection: "Connect your LinkedIn account first.",
  expired: "Your LinkedIn connection has expired. Reconnect LinkedIn first.",
  ledger: "The ledger already has a LinkedIn event for this date, so another one won't be created.",
  confirm: "Not confirmed: use the Create live event button and confirm in the dialog.",
  duplicate: "LinkedIn already lists a BOCC event with the same name or on the same day.",
  image: "The cover image can't be sent to LinkedIn.",
});

const refusal = (code, message = REFUSALS[code]) => ({ code, message });

/**
 * Everything the event is built from, for one date and location.
 * @param {{ date: string, location?: "lobby"|"food_hall"|"other"|null }} input
 * @returns {{ ok: true, spec: EventSpec } | { ok: false, refusal: { code: string, message: string } }}
 * @typedef {{ date: string, location: "lobby"|"food_hall"|null, name: string, description: string,
 *   venueDetails: string, commentary: string, startsAt: number, endsAt: number }} EventSpec
 */
export function buildEventSpec({ date, location = null }) {
  if (location === "other") return { ok: false, refusal: refusal("location_other") };
  const w = location === "food_hall" ? FOOD_HALL : NORMAL;
  return {
    ok: true,
    spec: {
      date,
      location: location ?? null,
      name: eventName(date),
      description: w.description(date),
      venueDetails: w.venueDetails,
      commentary: w.commentary,
      ...eventWindow(date),
    },
  };
}

const localized = (text) => ({ localized: { en_US: text } });
const rawText = (text) => localized({ rawText: text });

/** POST /rest/events body (events.py build_event_payload). Always LISTED. */
export function buildEventPayload(spec, backgroundAssetUrn) {
  return {
    organizer: ORGANIZER_URN,
    name: localized(spec.name),
    description: rawText(spec.description),
    startsAt: spec.startsAt,
    type: {
      inPerson: {
        endsAt: spec.endsAt,
        url: EXTERNAL_URL,
        address: { ...EVENT_ADDRESS },
        venueDetails: rawText(spec.venueDetails),
      },
    },
    discoveryMode: "LISTED",
    backgroundImage: backgroundAssetUrn,
  };
}

/** POST /rest/images?action=initializeUpload body: the member owns the image. */
export function buildImageUploadPayload(ownerUrn) {
  return { initializeUploadRequest: { owner: ownerUrn } };
}

/** POST /rest/posts body: the member's public post that publishes the event. */
export function buildPostPayload(authorUrn, eventId, commentary) {
  return {
    author: authorUrn,
    commentary,
    visibility: "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    content: { reference: { id: `urn:li:event:${eventId}` } },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
}
