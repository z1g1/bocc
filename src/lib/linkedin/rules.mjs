// Pure LinkedIn rules (ADR 0012). No database, no network, no imports, so unit tests
// and the browser-free Thursday check can load it. Later tickets add the event payload
// building, the allowed-actions matrix and drift detection here.

const DAY_MS = 86_400_000;

/** Days left under which the connection shows amber (red once expired). */
export const EXPIRY_WARNING_DAYS = 7;

/** The Thursday check alerts with fewer than this many days left (or once expired). */
export const EXPIRY_ALERT_DAYS = 10;

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
 * Whether the Thursday check should push the "reconnect LinkedIn" alert: fewer than
 * EXPIRY_ALERT_DAYS left, or already expired.
 * @param {Date|string|number} expiresAt
 * @param {Date} [now]
 */
export function expiryAlertDue(expiresAt, now = new Date()) {
  const left = new Date(expiresAt).getTime() - now.getTime();
  return !(left >= EXPIRY_ALERT_DAYS * DAY_MS);
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
