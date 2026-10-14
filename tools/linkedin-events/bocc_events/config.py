"""Fixed facts about the weekly BOCC event and the LinkedIn API we target.

Everything here is non-secret. Secrets (client ID/secret, tokens) come from
environment variables or the token file written by `bocc-event auth`; see auth.py.
"""

import os
from datetime import time
from pathlib import Path
from zoneinfo import ZoneInfo

# --- LinkedIn API -----------------------------------------------------------

API_BASE = "https://api.linkedin.com"

# LinkedIn versions its Marketing APIs monthly and sunsets each version after
# about a year. 202609 sunsets 2027-09-15
# (https://learn.microsoft.com/en-us/linkedin/marketing/integrations/migrations).
# Bump it deliberately, re-reading the migration notes, well before that date.
LINKEDIN_VERSION = "202609"

# BOCC showcase page. Showcase pages are addressed as urn:li:organization:{id}.
# The ID comes from the page's admin URL; `bocc-event check` verifies access to it.
ORGANIZATION_ID = os.environ.get("LINKEDIN_ORGANIZATION_ID", "89993057")
ORGANIZER_URN = f"urn:li:organization:{ORGANIZATION_ID}"

# --- The weekly event -------------------------------------------------------

EVENT_TZ = ZoneInfo("America/New_York")
EVENT_WEEKDAY = 1  # Tuesday (Monday == 0)
EVENT_START = time(7, 30)
EVENT_END = time(9, 0)

# Address shape follows the Events API Address schema (update example in the docs).
EVENT_ADDRESS = {
    "line1": "1 Seneca St",
    "city": "Buffalo",
    "geographicArea": "New York",
    "postalCode": "14203",
    "country": "US",
}
VENUE_DETAILS = "BOCC is right in the lobby, please come up the escalators"
EXTERNAL_URL = "https://www.eventbrite.com/e/buffalo-open-coffee-club-tickets-1983098086761"

# {md} is the event date as M/D without leading zeros, e.g. 10/6.
NAME_TEMPLATE = "Buffalo Open Coffee Club for {md}"
DESCRIPTION_TEMPLATE = (
    "Join us on {md} for Buffalo Open Coffee Club, Your First Free Entrepreneurial "
    "Step in Buffalo. A free, no-frills coffee meetup for the people building & "
    "running businesses in the 716."
)

# Commentary on the admin's personal post that publishes the event.
POST_COMMENTARY = "Please join me at Buffalo Open Coffee Club"

# Cover image used when --image isn't given. It lives in the tool's own
# directory (tools/linkedin-events/, one level above this package) so the CLI
# doesn't depend on the website's asset layout.
DEFAULT_IMAGE = Path(__file__).resolve().parents[1] / "default-bocc-image.png"
