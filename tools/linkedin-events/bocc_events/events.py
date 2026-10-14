"""Build, de-duplicate and create the weekly LinkedIn event.

API reference: https://learn.microsoft.com/en-us/linkedin/marketing/event-management/events
Notes from the docs that shape this module:
- startsAt/endsAt are UTC epoch ms; there's no timezone field.
- The organizer can only be set at creation.
- An event isn't visible to anyone, admins included, until it's posted.
  Posting as the page needs w_organization_social (Community Management API),
  which we don't have. A post by the admin personally (w_member_social) does
  publish it, and the page stays the organizer (confirmed 2026-10-02), so
  that's how we publish. LinkedIn rejects hidden (feedDistribution NONE)
  member posts as sponsored content, so the post is always a real feed post.
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


def build_member_post_payload(author_urn: str, event_id: str, commentary: str = config.POST_COMMENTARY) -> dict:
    """POST /rest/posts body: a public feed post by the admin that publishes the event."""
    return {
        "author": author_urn,
        "commentary": commentary,
        "visibility": "PUBLIC",
        "distribution": {"feedDistribution": "MAIN_FEED", "targetEntities": [], "thirdPartyDistributionChannels": []},
        "content": {"reference": {"id": f"urn:li:event:{event_id}"}},
        "lifecycleState": "PUBLISHED",
        "isReshareDisabledByAuthor": False,
    }


def build_image_upload_payload(owner_urn: str) -> dict:
    """POST /rest/images?action=initializeUpload body for the cover image.

    The Events docs use /rest/assets?action=registerUpload, but LinkedIn gates that
    (partnerApiAssets) to partner apps: it 403s for us even with w_member_social
    (confirmed 2026-10-14). The Images API accepts w_member_social.
    """
    return {"initializeUploadRequest": {"owner": owner_urn}}


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


def post_url(post_urn: str) -> str:
    return f"https://www.linkedin.com/feed/update/{post_urn}/"


def event_url(event: dict) -> str:
    """Public event link. LinkedIn routes events by vanityName (slug + id); fall back to the id."""
    slug = str(event.get("vanityName") or event.get("id") or "")
    if not all(c.isalnum() or c == "-" for c in slug):  # never build a path from odd input
        slug = str(event.get("id", ""))
    return f"https://www.linkedin.com/events/{slug}/"


# --- Writing -------------------------------------------------------------------


IMAGE_URN_PREFIX = "urn:li:image:"
ASSET_URN_PREFIX = "urn:li:digitalmediaAsset:"


def initialize_image_upload(client: LinkedInClient, owner_urn: str) -> tuple[str, str]:
    """Return (upload_url, asset_urn) for a new cover image.

    backgroundImage takes a digitalmediaAsset URN; an image URN shares its id with
    the underlying digital media asset, so only the prefix changes.
    """
    resp = client.post_json("/rest/images", build_image_upload_payload(owner_urn), query="action=initializeUpload")
    value = resp.json().get("value", {})
    upload_url, image = value.get("uploadUrl"), value.get("image", "")
    image_id = image.removeprefix(IMAGE_URN_PREFIX)
    if not upload_url or not image.startswith(IMAGE_URN_PREFIX) or not image_id or not all(c.isalnum() or c in "-_" for c in image_id):
        raise ApiError(resp.status, "initializeUpload response was missing uploadUrl or image")
    return upload_url, ASSET_URN_PREFIX + image_id


def create_event(client: LinkedInClient, payload: dict) -> dict:
    """Create the event and return {"id": str, "vanityName": str | None}."""
    resp = client.post_json("/rest/events", payload, restli_method="create")
    body = resp.json() if resp.body else {}
    event_id = str(body.get("id") or resp.headers.get("x-restli-id", ""))
    if not event_id.isdigit():
        # A 2xx means the event probably exists, so this is "maybe created", not a failure.
        raise UncertainResult("LinkedIn accepted the event but returned no numeric id; check the page's events in LinkedIn")
    return {"id": event_id, "vanityName": body.get("vanityName")}


def post_event(client: LinkedInClient, author_urn: str, event_id: str) -> str:
    """Publish the event with a post by `author_urn`; return the post URN. Never retried."""
    resp = client.post_json("/rest/posts", build_member_post_payload(author_urn, event_id))
    post_urn = resp.headers.get("x-restli-id", "")
    if not post_urn.startswith(("urn:li:ugcPost:", "urn:li:share:")) or not post_urn.split(":")[-1].isdigit():
        raise UncertainResult("LinkedIn accepted the post but returned no post id; check your profile's activity")
    return post_urn
