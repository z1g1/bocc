import json
from datetime import date, datetime, timezone

import pytest

from bocc_events import config, events
from bocc_events.client import ApiError, LinkedInClient, Response, UncertainResult
from bocc_events.ledger import CREATED, PENDING, Ledger

DAY = date(2026, 10, 6)


class Transport:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append({"method": method, "url": url, "headers": headers, "body": body})
        return self.responses.pop(0)


def client_with(*responses):
    transport = Transport(*responses)
    return LinkedInClient("tok", transport=transport, sleep=lambda s: None), transport


def resp(payload, status=200, headers=None):
    return Response(status, headers or {}, json.dumps(payload).encode())


def li_event(name, starts_at_ms, event_id=1):
    return {"id": event_id, "name": {"localized": {"en_US": name}}, "startsAt": starts_at_ms}


# --- payloads ----------------------------------------------------------------------


def test_build_spec_matches_weekly_format():
    spec = events.build_spec(DAY)
    assert spec.name == "Buffalo Open Coffee Club for 10/6"
    assert spec.description.startswith("Join us on 10/6 for Buffalo Open Coffee Club,")
    assert spec.ends_at_ms - spec.starts_at_ms == 90 * 60 * 1000
    assert spec.discovery_mode == "LISTED"


def test_build_spec_rejects_unknown_discovery_mode():
    with pytest.raises(ValueError):
        events.build_spec(DAY, "PRIVATE")


def test_event_payload_shape():
    spec = events.build_spec(DAY, events.URL_ONLY)
    payload = events.build_event_payload(spec, "urn:li:digitalmediaAsset:ABC")
    assert payload == {
        "organizer": config.ORGANIZER_URN,
        "name": {"localized": {"en_US": "Buffalo Open Coffee Club for 10/6"}},
        "description": {"localized": {"en_US": {"rawText": spec.description}}},
        "startsAt": 1791286200000,
        "type": {
            "inPerson": {
                "endsAt": 1791291600000,
                "url": config.EXTERNAL_URL,
                "address": {
                    "line1": "1 Seneca St",
                    "city": "Buffalo",
                    "geographicArea": "New York",
                    "postalCode": "14203",
                    "country": "US",
                },
                "venueDetails": {"localized": {"en_US": {"rawText": config.VENUE_DETAILS}}},
            }
        },
        "discoveryMode": "URL_ONLY",
        "backgroundImage": "urn:li:digitalmediaAsset:ABC",
    }


def test_event_payload_omits_missing_image():
    assert "backgroundImage" not in events.build_event_payload(events.build_spec(DAY), None)


def test_register_upload_payload():
    body = events.build_register_upload_payload("urn:li:person:me")["registerUploadRequest"]
    assert body["owner"] == "urn:li:person:me"
    assert body["recipes"] == ["urn:li:digitalmediaRecipe:event-background-image"]


# --- listing and duplicates ----------------------------------------------------------


def test_list_upcoming_events_query():
    client, transport = client_with(resp({"elements": [li_event("x", 1)]}))
    assert len(events.list_upcoming_events(client)) == 1
    url = transport.calls[0]["url"]
    assert "q=eventsByOrganizer" in url
    assert "organizer=urn%3Ali%3Aorganization%3A" in url
    assert "timeBasedFilter=(lifeCycleState:UPCOMING)" in url


def test_list_upcoming_events_pages():
    full = {"elements": [li_event("x", 1)] * events.PAGE_SIZE}
    client, transport = client_with(resp(full), resp({"elements": [li_event("y", 2)]}))
    assert len(events.list_upcoming_events(client)) == events.PAGE_SIZE + 1
    assert "start=50" in transport.calls[1]["url"]


def test_list_upcoming_events_page_cap():
    full = {"elements": [li_event("x", 1)] * events.PAGE_SIZE}
    client, _ = client_with(*[resp(full)] * events.MAX_PAGES)
    with pytest.raises(ApiError, match="refusing"):
        events.list_upcoming_events(client)


def test_find_duplicates_by_name_or_day():
    spec = events.build_spec(DAY)
    same_name = li_event("buffalo open coffee club for 10/6", 0, 1)
    same_day = li_event("Something else", spec.starts_at_ms + 3600_000, 2)
    other = li_event("Buffalo Open Coffee Club for 10/13", events.build_spec(date(2026, 10, 13)).starts_at_ms, 3)
    assert [e["id"] for e in events.find_duplicates([same_name, same_day, other], spec)] == [1, 2]


def test_event_day_uses_eastern_time():
    # 2026-10-07 01:00 UTC is still the evening of 10/6 in Buffalo.
    late = int(datetime(2026, 10, 7, 1, 0, tzinfo=timezone.utc).timestamp() * 1000)
    assert events.event_day(li_event("x", late)) == DAY


# --- writes ---------------------------------------------------------------------------


def test_register_upload_parses_response():
    body = {
        "value": {
            "asset": "urn:li:digitalmediaAsset:D55",
            "uploadMechanism": {
                "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": {"uploadUrl": "https://api.linkedin.com/up"}
            },
        }
    }
    client, transport = client_with(resp(body))
    assert events.register_upload(client, "urn:li:person:me") == ("https://api.linkedin.com/up", "urn:li:digitalmediaAsset:D55")
    assert transport.calls[0]["url"].endswith("/rest/assets?action=registerUpload")


def test_register_upload_rejects_incomplete_response():
    client, _ = client_with(resp({"value": {}}))
    with pytest.raises(ApiError):
        events.register_upload(client, "urn:li:person:me")


def test_create_event_returns_id_beyond_float_precision():
    client, transport = client_with(resp({"id": 7249812613549670400, "vanityName": "x"}, status=201))
    assert events.create_event(client, {}) == {"id": "7249812613549670400", "vanityName": "x"}
    assert transport.calls[0]["headers"]["X-RestLi-Method"] == "create"


def test_create_event_falls_back_to_restli_header():
    client, _ = client_with(Response(201, {"x-restli-id": "123"}, b""))
    assert events.create_event(client, {})["id"] == "123"


def test_create_event_without_id_says_check_linkedin():
    client, _ = client_with(resp({}, status=201))
    with pytest.raises(UncertainResult, match="check the page"):
        events.create_event(client, {})


# --- ledger ---------------------------------------------------------------------------


def test_ledger_lifecycle(tmp_path):
    ledger = Ledger(tmp_path / "state" / "ledger.json")
    now = datetime(2026, 10, 2, tzinfo=timezone.utc)
    assert ledger.get(DAY) is None
    ledger.record_pending(DAY, "name", now)
    assert ledger.get(DAY)["status"] == PENDING
    ledger.record_created(DAY, "123", events.event_url({"id": "123"}), now)
    entry = ledger.get(DAY)
    assert (entry["status"], entry["event_id"], entry["name"]) == (CREATED, "123", "name")
    assert ledger.path.stat().st_mode & 0o777 == 0o600
    assert ledger.forget(DAY) and ledger.get(DAY) is None
    assert not ledger.forget(DAY)


def test_event_url_prefers_vanity_name():
    vanity = "buffaloopencoffeeclubfor10-67509297807225167873"
    assert events.event_url({"id": 7509297807225167873, "vanityName": vanity}) == f"https://www.linkedin.com/events/{vanity}/"
    assert events.event_url({"id": 5}) == "https://www.linkedin.com/events/5/"
    assert events.event_url({"id": 5, "vanityName": "../evil"}) == "https://www.linkedin.com/events/5/"
