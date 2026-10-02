# bocc-event: weekly BOCC LinkedIn event

Creates the Tuesday "Buffalo Open Coffee Club for M/D" event on the BOCC LinkedIn showcase
page through LinkedIn's official Event Management API, replacing manual UI clicking.

**What it does:** validates the date and cover photo, checks for an existing event, uploads
the cover, creates the event, and prints its link.

**What it doesn't do:** publish the event. LinkedIn only lets apps post as a page with the
vetted Community Management API. The admin opens the printed link and publishes the event
from LinkedIn as the page, then reshares it. Permissions and the reasoning are in
[`docs/backend/LINKEDIN_PERMISSIONS.md`](../../docs/backend/LINKEDIN_PERMISSIONS.md).

> **Unverified:** whether an API-created, unposted event can be opened and published from the
> LinkedIn UI. The docs only say it isn't public until posted. Confirm with the first live run
> (see "First live test").

## Setup

1. **LinkedIn app.** Create one at https://www.linkedin.com/developers/apps, associate it with
   the BOCC page, and add the products **Event Management API** and **Sign In with LinkedIn
   using OpenID Connect**. On the Auth tab, add the redirect URL `http://localhost:8765/callback`.
2. **Install** (Python 3.12+, [uv](https://docs.astral.sh/uv/)):
   ```bash
   cd tools/linkedin-events
   uv sync
   ```
3. **Authorize** as a page admin (one time, and again every 60 days):
   ```bash
   export LINKEDIN_CLIENT_ID=...       # from the app's Auth tab
   read -rs LINKEDIN_CLIENT_SECRET && export LINKEDIN_CLIENT_SECRET   # keeps it out of shell history
   uv run bocc-event auth
   ```
   Open the printed URL and approve. Your browser then fails to load `localhost`, which is
   expected. Paste that URL back into the prompt. The token is saved to
   `~/.config/bocc-linkedin/token.env` (mode 0600).
4. **Check access** (proves the token, the page role and the organization ID):
   ```bash
   uv run bocc-event check
   ```

## Weekly use

```bash
uv run bocc-event create --image ~/photos/this-week.jpg          # dry run: prints payloads, sends nothing
uv run bocc-event create --image ~/photos/this-week.jpg --live   # asks "yes", then creates
```

Options: `--date YYYY-MM-DD` (must be a future Tuesday; defaults to next Tuesday),
`--no-image` (use LinkedIn's default cover), `--url-only` (unlisted, for tests),
`--yes` (skip the prompt; required when there's no terminal).
Without `--image` the tool uses `default-bocc-image.png` from this directory (replace that file to change the default). Images must be real PNG/JPEG files,
at least 480x270 and no larger than 8 MiB. 16:9 is recommended.

Then open the printed link, publish it as the BOCC page, and reshare it from your profile
with "Please join me at Buffalo Open Coffee Club".

### Duplicate protection

The tool keeps a local ledger at `~/.local/state/bocc-linkedin/ledger.json`, because
unposted events may be invisible to the API. A date that has already been attempted is
refused. If a run dies mid-create, the entry stays `pending`. In that case, check the page's
events on LinkedIn, then run `uv run bocc-event forget --date YYYY-MM-DD` to allow a retry.
The tool also refuses if LinkedIn already lists an event with the same name or date.

An event that was created but never posted **can't be deleted through the API**. If one goes
wrong, remove it in the LinkedIn UI.

## Running from CI or another machine

Set `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_TOKEN_EXPIRES_AT` and `LINKEDIN_PERSON_URN` as
secrets. When these are set, the token file is ignored. To copy them from the token file
without printing them:

```bash
( set -a; . ~/.config/bocc-linkedin/token.env
  for k in LINKEDIN_ACCESS_TOKEN LINKEDIN_TOKEN_EXPIRES_AT LINKEDIN_PERSON_URN; do
    printf %s "${!k}" | gh secret set "$k"; done )
```

The ledger is per machine, so a CI job needs to persist it (or run only on demand).

## First live test

1. `uv run bocc-event check`: expect `Organizer urn:li:organization:89993057: N upcoming...`.
   A 403 means the app is missing a product or your page role is wrong.
2. Create the real next event unlisted: `uv run bocc-event create --url-only --live`.
3. Open the printed link while signed in as a page admin and confirm you can publish it as the page.
   If the link doesn't resolve, try the page's admin **Events** tab.
4. Record the result here. If it can't be published from the UI, the fallback is
   Community Management API access (see the permissions doc).

## Development

```bash
uv run pytest      # unit tests; no network, no credentials
```

Layout: `config.py` (event facts, API version), `dates.py`, `images.py`, `client.py`
(HTTP), `auth.py` (OAuth and tokens), `events.py` (payloads, duplicate check, create),
`ledger.py`, `cli.py`. The runtime uses only the standard library; pytest is the only dev dependency.
