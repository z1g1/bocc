"""Build, de-duplicate and create the weekly LinkedIn event.

API reference: https://learn.microsoft.com/en-us/linkedin/marketing/event-management/events
Notes from the docs that shape this module:
- startsAt/endsAt are UTC epoch ms; there's no timezone field.
- The organizer can only be set at creation.
- An event isn't public until someone posts it. Posting as the page needs
  w_organization_social (Community Management API), which we don't have.
  The admin publishes it from LinkedIn's UI instead.
- Until it's posted, the event can't be fetched, updated or deleted through
  the API, and may not show up in eventsByOrganizer. The local ledger
  (ledger.py) is therefore the primary duplicate guard and this listing check
  is the secondary one.
"""

from dataclasses import dataclass
from datetime import date, datetime, timezone

from . import config
from .client import ApiError, LinkedInClient, UncertainResult, build_query
from .dates import event_window, month_day, to_epoch_ms

LISTED = "LISTED"
URL_ONLY = "URL_ONLY"
DISCOVERY_MODES = (LISTED, URL_ONLY)
PAGE_SIZE = 50
MAX_PAGES = 10


@dataclass(frozen=True)
class EventSpec:
    """Everything about one week's event, independent of API shape."""

    day: date
    name: str
    description: str
    starts_at_ms: int
    ends_at_ms: int
    discovery_mode: str


def build_spec(day: date, discovery_mode: str = LISTED) -> EventSpec:
    if discovery_mode not in DISCOVERY_MODES:
        raise ValueError(f"discovery mode must be one of {DISCOVERY_MODES}")
    start, end = event_window(day)
    md = month_day(day)
    return EventSpec(
        day=day,
        name=config.NAME_TEMPLATE.format(md=md),
        description=config.DESCRIPTION_TEMPLATE.format(md=md),
        starts_at_ms=to_epoch_ms(start),
        ends_at_ms=to_epoch_ms(end),
        discovery_mode=discovery_mode,
    )


def build_event_payload(spec: EventSpec, background_asset: str | None) -> dict:
    """POST /rest/events body for an in-person event organized by the BOCC page."""
    payload = {
        "organizer": config.ORGANIZER_URN,
        "name": {"localized": {"en_US": spec.name}},
        "description": {"localized": {"en_US": {"rawText": spec.description}}},
        "startsAt": spec.starts_at_ms,
        "type": {
            "inPerson": {
                "endsAt": spec.ends_at_ms,
                "url": config.EXTERNAL_URL,
                "address": dict(config.EVENT_ADDRESS),
                "venueDetails": {"localized": {"en_US": {"rawText": config.VENUE_DETAILS}}},
            }
        },
        "discoveryMode": spec.discovery_mode,
    }
    if background_asset:
        payload["backgroundImage"] = background_asset
    return payload


def build_register_upload_payload(owner_urn: str) -> dict:
    """POST /rest/assets?action=registerUpload body for an event background image."""
    return {
        "registerUploadRequest": {
            "owner": owner_urn,
            "recipes": ["urn:li:digitalmediaRecipe:event-background-image"],
            "serviceRelationships": [
                {"identifier": "urn:li:userGeneratedContent", "relationshipType": "OWNER"}
            ],
            "supportedUploadMechanism": ["SYNCHRONOUS_UPLOAD"],
        }
    }


# --- Reading -----------------------------------------------------------------


def list_upcoming_events(client: LinkedInClient, organizer_urn: str = config.ORGANIZER_URN) -> list[dict]:
    """All upcoming, non-cancelled events for the organizer (paged, with a hard page cap)."""
    events: list[dict] = []
    for page in range(MAX_PAGES):
        query = build_query(
            {
                "q": "eventsByOrganizer",
                "organizer": organizer_urn,
                "start": str(page * PAGE_SIZE),
                "count": str(PAGE_SIZE),
                "excludeCancelled": "true",
                "sortOrder": "START_TIME_ASC",
            },
            # Rest.li tuple syntax; the docs say this must not be URL-encoded.
            raw={"timeBasedFilter": "(lifeCycleState:UPCOMING)"},
        )
        elements = client.get("/rest/events", query).get("elements", [])
        events.extend(elements)
        if len(elements) < PAGE_SIZE:
            return events
    raise ApiError(0, f"more than {MAX_PAGES * PAGE_SIZE} upcoming events; refusing to guess at duplicates")


def event_name(event: dict) -> str:
    return event.get("name", {}).get("localized", {}).get("en_US", "")


def event_day(event: dict) -> date | None:
    starts_at = event.get("startsAt")
    if not isinstance(starts_at, int):
        return None
    return datetime.fromtimestamp(starts_at / 1000, tz=timezone.utc).astimezone(config.EVENT_TZ).date()


def find_duplicates(events: list[dict], spec: EventSpec) -> list[dict]:
    """Events with the same name, or on the same Eastern calendar day, as `spec`."""
    want = spec.name.casefold()
    return [e for e in events if event_name(e).casefold() == want or event_day(e) == spec.day]


def event_url(event: dict) -> str:
    """Public event link. LinkedIn routes events by vanityName (slug + id); fall back to the id."""
    slug = str(event.get("vanityName") or event.get("id") or "")
    if not all(c.isalnum() or c == "-" for c in slug):  # never build a path from odd input
        slug = str(event.get("id", ""))
    return f"https://www.linkedin.com/events/{slug}/"


# --- Writing -------------------------------------------------------------------


def register_upload(client: LinkedInClient, owner_urn: str) -> tuple[str, str]:
    """Return (upload_url, asset_urn) for a new event background image."""
    resp = client.post_json("/rest/assets", build_register_upload_payload(owner_urn), query="action=registerUpload")
    value = resp.json().get("value", {})
    mechanism = value.get("uploadMechanism", {}).get("com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest", {})
    upload_url, asset = mechanism.get("uploadUrl"), value.get("asset", "")
    if not upload_url or not asset.startswith("urn:li:digitalmediaAsset:"):
        raise ApiError(resp.status, "registerUpload response was missing uploadUrl or asset")
    return upload_url, asset


def create_event(client: LinkedInClient, payload: dict) -> dict:
    """Create the event and return {"id": str, "vanityName": str | None}."""
    resp = client.post_json("/rest/events", payload, restli_method="create")
    body = resp.json() if resp.body else {}
    event_id = str(body.get("id") or resp.headers.get("x-restli-id", ""))
    if not event_id.isdigit():
        # A 2xx means the event probably exists, so this is "maybe created", not a failure.
        raise UncertainResult("LinkedIn accepted the event but returned no numeric id; check the page's events in LinkedIn")
    return {"id": event_id, "vanityName": body.get("vanityName")}
