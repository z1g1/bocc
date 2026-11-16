// Upcoming Tuesday event pages, built at build time (port of
// scripts/generate_event_pages.rb). Phase 4 moves these to Neon (ADR 0009).
import { data } from "./data";
import { easternOffset, todayEastern } from "./time";

const WEEKS = 13;
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export interface EventPage {
  date: string; // YYYY-MM-DD
  title: string;
  event_name: string;
  heading: string;
  description: string;
  long_date: string;
  start_date: string;
  end_date: string;
  luma_url?: string;
  luma_event_id?: string;
}

// The Tuesdays in the Christmas and New Year's weeks always fall in this window.
const holidayBreak = (m: number, d: number) => (m === 12 && d >= 20) || (m === 1 && d <= 2);

const pad = (n: number) => String(n).padStart(2, "0");

export function upcomingEvents(): EventPage[] {
  const luma: Record<string, { url?: string; id?: string }> = data("luma_events") ?? {};
  const { y, m, d } = todayEastern();
  // Work on calendar dates in UTC so no local time zone can shift them.
  const today = new Date(Date.UTC(y, m - 1, d));
  const first = new Date(today);
  first.setUTCDate(today.getUTCDate() + ((2 - today.getUTCDay() + 7) % 7));

  const out: EventPage[] = [];
  for (let week = 0; out.length < WEEKS; week++) {
    const dt = new Date(first);
    dt.setUTCDate(first.getUTCDate() + week * 7);
    const [yy, mm, dd] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
    if (holidayBreak(mm, dd)) continue;
    const iso = `${yy}-${pad(mm)}-${pad(dd)}`;
    const longDate = `${DAYS[dt.getUTCDay()]}, ${MONTHS[mm - 1]} ${dd}, ${yy}`;
    const entry = luma[iso] ?? {};
    out.push({
      date: iso,
      title: longDate,
      event_name: `Buffalo Open Coffee Club: ${longDate}`,
      heading: `Buffalo Open Coffee Club on ${MONTHS[mm - 1]} ${dd}`,
      description:
        "Free networking for Buffalo's entrepreneurs, small business owners, " +
        `and startup founders on ${longDate}, 7:30-9:00 AM at Seneca One Tower.`,
      long_date: longDate,
      start_date: `${iso}T07:30:00${easternOffset(yy, mm, dd, 7, 30)}`,
      end_date: `${iso}T09:00:00${easternOffset(yy, mm, dd, 9, 0)}`,
      luma_url: entry.url,
      luma_event_id: entry.id,
    });
  }
  return out;
}
