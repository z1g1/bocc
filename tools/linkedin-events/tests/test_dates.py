from datetime import date, datetime, timezone

import pytest

from bocc_events import config
from bocc_events.dates import (
    DateError,
    event_window,
    month_day,
    next_event_date,
    resolve_event_date,
    to_epoch_ms,
)


def eastern(*args):
    return datetime(*args, tzinfo=config.EVENT_TZ)


@pytest.mark.parametrize(
    "today, expected",
    [
        (date(2026, 10, 2), date(2026, 10, 6)),  # Friday -> next Tuesday
        (date(2026, 10, 5), date(2026, 10, 6)),  # Monday -> tomorrow
        (date(2026, 10, 6), date(2026, 10, 13)),  # Tuesday -> a week out, never today
        (date(2026, 10, 7), date(2026, 10, 13)),  # Wednesday
    ],
)
def test_next_event_date(today, expected):
    assert next_event_date(today) == expected


def test_month_day_has_no_leading_zeros():
    assert month_day(date(2026, 10, 6)) == "10/6"
    assert month_day(date(2026, 1, 13)) == "1/13"


def test_event_window_is_eastern_and_dst_aware():
    # EDT (UTC-4) in October, EST (UTC-5) after the November 1 2026 change.
    start, end = event_window(date(2026, 10, 6))
    assert start.astimezone(timezone.utc).hour == 11 and start.minute == 30
    assert end.astimezone(timezone.utc).hour == 13
    start, _ = event_window(date(2026, 11, 3))
    assert start.astimezone(timezone.utc).hour == 12


def test_to_epoch_ms():
    assert to_epoch_ms(eastern(2026, 10, 6, 7, 30)) == 1791286200000


def test_to_epoch_ms_rejects_naive():
    with pytest.raises(ValueError):
        to_epoch_ms(datetime(2026, 10, 6, 7, 30))


def test_resolve_defaults_to_next_tuesday():
    assert resolve_event_date(None, eastern(2026, 10, 2, 12, 0)) == date(2026, 10, 6)


def test_resolve_accepts_future_tuesday():
    assert resolve_event_date("2026-10-13", eastern(2026, 10, 2, 12, 0)) == date(2026, 10, 13)


def test_resolve_allows_same_day_before_start():
    assert resolve_event_date("2026-10-06", eastern(2026, 10, 6, 6, 0)) == date(2026, 10, 6)


@pytest.mark.parametrize(
    "raw, now, message",
    [
        ("10/13/2026", eastern(2026, 10, 2, 12), "YYYY-MM-DD"),
        ("2026-10-14", eastern(2026, 10, 2, 12), "not a Tuesday"),
        ("2026-09-29", eastern(2026, 10, 2, 12), "not in the future"),
        ("2026-10-06", eastern(2026, 10, 6, 7, 30), "not in the future"),
        ("2027-10-05", eastern(2026, 10, 2, 12), "120 days"),
    ],
)
def test_resolve_rejects_bad_dates(raw, now, message):
    with pytest.raises(DateError, match=message):
        resolve_event_date(raw, now)


def test_resolve_requires_aware_now():
    with pytest.raises(ValueError):
        resolve_event_date(None, datetime(2026, 10, 2, 12))
