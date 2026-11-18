// The public event page for one date (ADR 0009 decision 4): the date helpers and the
// fields the page, its Seo tags and its Event JSON-LD need. The facts themselves
// (status, location, Luma and the other listings) come from Neon on request, through
// src/lib/site/db.mjs. Nothing here reads a file or the database.
import { easternOffset, todayEastern } from "./time";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export type EventStatus = "scheduled" | "held" | "cancelled";

export interface EventPage {
  date: string; // YYYY-MM-DD
  title: string;
  event_name: string;
  heading: string;
  description: string;
  long_date: string;
  month_day: string; // "November 24"
  start_date: string;
  end_date: string;
  luma_url?: string;
  luma_event_id?: string;
  /** schema.org eventStatus; only "cancelled" changes it from EventScheduled. */
  status?: EventStatus;
  /** The other listings (Eventbrite, Facebook, LinkedIn), for JSON-LD sameAs only. */
  same_as?: string[];
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The Y-M-D parts of a real calendar date written YYYY-MM-DD, or null. */
export function parseIsoDate(s: unknown): { y: number; m: number; d: number } | null {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return { y, m, d };
}

/** Today in Buffalo as YYYY-MM-DD (BOCC_TODAY overrides it, see src/lib/time.ts). */
export function todayIso(): string {
  const { y, m, d } = todayEastern();
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** "Tuesday, November 24, 2026" for a valid YYYY-MM-DD. */
export function longDate(iso: string): string {
  const p = parseIsoDate(iso);
  if (!p) throw new Error(`not a date: ${iso}`);
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d));
  return `${DAYS[dt.getUTCDay()]}, ${MONTHS[p.m - 1]} ${p.d}, ${p.y}`;
}

/** The page fields for one date. Same text the static pages had. */
export function eventPage(iso: string, extra: Pick<EventPage, "luma_url" | "luma_event_id" | "status" | "same_as"> = {}): EventPage {
  const p = parseIsoDate(iso);
  if (!p) throw new Error(`not a date: ${iso}`);
  const { y, m, d } = p;
  const long = longDate(iso);
  return {
    date: iso,
    title: long,
    event_name: `Buffalo Open Coffee Club: ${long}`,
    heading: `Buffalo Open Coffee Club on ${MONTHS[m - 1]} ${d}`,
    description:
      "Free networking for Buffalo's entrepreneurs, small business owners, " +
      `and startup founders on ${long}, 7:30-9:00 AM at Seneca One Tower.`,
    long_date: long,
    month_day: `${MONTHS[m - 1]} ${d}`,
    start_date: `${iso}T07:30:00${easternOffset(y, m, d, 7, 30)}`,
    end_date: `${iso}T09:00:00${easternOffset(y, m, d, 9, 0)}`,
    ...extra,
  };
}
