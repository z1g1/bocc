"""Date handling for the weekly event: picking the Tuesday and converting to epoch ms.

The Events API takes startsAt/endsAt as UTC epoch milliseconds with no timezone
field, so all wall-clock math happens here in America/New_York (DST-aware).
"""

from datetime import date, datetime, timedelta

from . import config


class DateError(ValueError):
    """The requested event date is unusable (bad format, not a Tuesday, in the past)."""


def next_event_date(today: date) -> date:
    """Return the first Tuesday strictly after `today`.

    Strictly after, so running on a Tuesday targets next week rather than an
    event that is already underway or over.
    """
    days_ahead = (config.EVENT_WEEKDAY - today.weekday()) % 7 or 7
    return today + timedelta(days=days_ahead)


def event_window(day: date) -> tuple[datetime, datetime]:
    """Return timezone-aware (start, end) datetimes for the event on `day`."""
    start = datetime.combine(day, config.EVENT_START, tzinfo=config.EVENT_TZ)
    end = datetime.combine(day, config.EVENT_END, tzinfo=config.EVENT_TZ)
    return start, end


def to_epoch_ms(moment: datetime) -> int:
    """Convert an aware datetime to integer epoch milliseconds."""
    if moment.tzinfo is None:
        raise ValueError("refusing to convert a naive datetime")
    return int(moment.timestamp() * 1000)


def month_day(day: date) -> str:
    """Format as M/D without leading zeros (10/6, not 10/06)."""
    return f"{day.month}/{day.day}"


def resolve_event_date(raw: str | None, now: datetime) -> date:
    """Parse and validate the --date argument, defaulting to next Tuesday.

    `now` must be timezone-aware; it is compared against the event's start time
    so an event that has already begun is rejected even on its own day.
    """
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    local_today = now.astimezone(config.EVENT_TZ).date()

    if raw is None:
        day = next_event_date(local_today)
    else:
        try:
            day = date.fromisoformat(raw)
        except ValueError:
            raise DateError(f"date must be YYYY-MM-DD, got {raw!r}") from None
        if day.weekday() != config.EVENT_WEEKDAY:
            raise DateError(f"{day.isoformat()} is a {day.strftime('%A')}, not a Tuesday")

    start, _ = event_window(day)
    if start <= now:
        raise DateError(f"{day.isoformat()} {config.EVENT_START:%H:%M} Eastern is not in the future")
    # Guard against typos like 2062: LinkedIn events this far out are almost certainly a mistake.
    if day > local_today + timedelta(days=120):
        raise DateError(f"{day.isoformat()} is more than 120 days away; check the year")
    return day
