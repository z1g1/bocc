// Build time and "today", with overrides so a build can be reproduced exactly.
//   BOCC_BUILD_TIME=2026-11-08T18:37:43Z  pins timestamps (sitemap, feed, og tags)
//   BOCC_TODAY=2026-11-08                 pins which Tuesdays get event pages
const TZ = "America/New_York";

export const buildTime: Date = process.env.BOCC_BUILD_TIME
  ? new Date(process.env.BOCC_BUILD_TIME)
  : new Date();

/** "2026-11-08T18:37:43+00:00", the format Jekyll used for site.time in UTC. */
export function isoUtc(d: Date = buildTime): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/** Today's date in Buffalo, as Y-M-D numbers. */
export function todayEastern(): { y: number; m: number; d: number } {
  if (process.env.BOCC_TODAY) {
    const [y, m, d] = process.env.BOCC_TODAY.split("-").map(Number);
    return { y, m, d };
  }
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/** UTC offset of America/New_York at a given local wall-clock time, as "-05:00" / "-04:00". */
export function easternOffset(y: number, m: number, d: number, hh: number, mm: number): string {
  // Interpret the wall time as UTC, then see what Eastern reads at that instant.
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
  }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asEastern = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  const offsetMin = Math.round((asEastern - guess) / 60000);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export const footerYear = (): number =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric" }).format(buildTime));
