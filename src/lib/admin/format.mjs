// Display helpers for the admin data views. Times are shown in Eastern, BOCC's time.
const TZ = "America/New_York";

const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const dateTimeFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" });
const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });

/** 7:42 AM (Eastern) */
export const easternTime = (d) => (d ? timeFmt.format(new Date(d)) : "");
/** Nov 17, 2026, 7:42 AM (Eastern) */
export const easternDateTime = (d) => (d ? dateTimeFmt.format(new Date(d)) : "");
/** "2026-11-17" -> "Tue, Nov 17, 2026" (a calendar day, no timezone shift) */
export const longDay = (ymd) => (ymd ? dayFmt.format(new Date(`${ymd}T00:00:00Z`)) : "");
