// Active streaks for /admin/streaks/ (admin only; the CALLER checks requireRole).
//
// "Active" follows the streaks view (migrations 20260625120100, 20260912120000 and
// 20261203190000): current_streak is the run ending at the event's most recent HELD week
// (a week with a non-debug check-in or a Reported Event, and no Cancelled Event), and 0
// if the attendee missed that week. So an
// active streak is current_streak > 0. The view already ignores debug check-ins;
// debug attendees are left out here as well.
//
//   listActiveStreaks(db, { minStreak, eventId }) -> [{ attendeeId, eventId, name,
//     businessName, email, currentStreak, longestStreak, isPersonalBest, weeksAttended,
//     lastCheckinAt }]

/** @param {{ query: Function }} db */
export async function listActiveStreaks(db, { minStreak = 1, eventId = null } = {}) {
  const min = Number.isInteger(minStreak) && minStreak > 0 ? minStreak : 1;
  const { rows } = await db.query(
    `select s.attendee_id          as "attendeeId",
            s.event_id             as "eventId",
            a.name,
            a.business_name        as "businessName",
            a.email,
            s.current_streak::int  as "currentStreak",
            s.longest_streak::int  as "longestStreak",
            s.is_personal_best     as "isPersonalBest",
            s.weeks_attended::int  as "weeksAttended",
            s.last_checkin_at      as "lastCheckinAt"
       from public.streaks s
       join public.attendees a on a.id = s.attendee_id
      where s.current_streak >= $1
        and a.debug = false
        and ($2::text is null or s.event_id = $2)
      order by s.current_streak desc, s.longest_streak desc, a.name, a.email`,
    [min, eventId],
  );
  return rows;
}
