# bocc-event: weekly BOCC LinkedIn event

Creates the Tuesday "Buffalo Open Coffee Club for M/D" event on the BOCC LinkedIn showcase
page through LinkedIn's official Event Management API, replacing manual UI clicking.

**What it does:** validates the date and cover photo, checks for an existing event, uploads
the cover, creates the event with the BOCC page as organizer, and publishes it with a public
post from your own profile ("Please join me at Buffalo Open Coffee Club").

**Why your profile and not the page:** LinkedIn hides an event from everyone, admins included,
until it's posted. Apps can only post as a page with the vetted Community Management API, but a
post from the admin's own profile (`w_member_social`) publishes it, and the page stays the
organizer. This was confirmed with the 10/13 event on 2026-10-02. After each run, **reshare your
post from the BOCC page** in LinkedIn. That's the one manual click left. Permissions and the
reasoning are in
[`docs/backend/LINKEDIN_PERMISSIONS.md`](../../docs/backend/LINKEDIN_PERMISSIONS.md).

## Setup

1. **LinkedIn app.** Create one at https://www.linkedin.com/developers/apps, associate it with
   the BOCC page, and add the products **Event Management API**, **Share on LinkedIn** (cover
   uploads and the publishing post) and **Sign In with LinkedIn using OpenID Connect**. On the Auth tab, add the redirect URL `http://localhost:8765/callback`.
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
uv run bocc-event create --image ~/photos/this-week.jpg --live   # asks "yes", then creates and posts
```

Options: `--date YYYY-MM-DD` (must be a future Tuesday; defaults to next Tuesday),
`--no-image` (use LinkedIn's default cover), `--url-only` (unlisted),
`--no-post` (create only, then publish later with `bocc-event post --date ...`),
`--yes` (skip the prompt; required when there's no terminal).
Without `--image` the tool uses `default-bocc-image.png` from this directory (replace that file to change the default). Images must be real PNG/JPEG files,
at least 480x270 and no larger than 8 MiB. 16:9 is recommended.

It prints the event link and your post link. Then reshare your post from the BOCC page.

If the post step fails, the event exists but is invisible. Fix the cause and run
`uv run bocc-event post --date YYYY-MM-DD`. It refuses to post a date twice.

### Duplicate protection

The tool keeps a local ledger at `~/.local/state/bocc-linkedin/ledger.json`, because
unposted events may be invisible to the API. A date that has already been attempted is
refused. If a run dies mid-create, the entry stays `pending`. In that case, check the page's
events on LinkedIn, then run `uv run bocc-event forget --date YYYY-MM-DD` to allow a retry.
The tool also refuses if LinkedIn already lists an event with the same name or date.

An event that was created but never posted is invisible and **can't be deleted**. Publish it
with `post`. To remove a published event, delete its post, which deletes the event.

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

## Verified behaviour (2026-10-02)

- `check` lists only *posted* events. API-created events don't appear until posted.
- A cover upload needs `w_member_social`; `rw_events` alone gets a 403.
- A member post (`author: urn:li:person:...`) referencing `urn:li:event:{id}` publishes a page-organized event.
- Hidden member posts (`feedDistribution: NONE`) are rejected as sponsored content, and
  the API can't create a DRAFT post, so every publish is a real feed post.
- `discoveryMode` can be changed after posting (partial update), e.g. `URL_ONLY` to `LISTED`.

## Development

```bash
uv run pytest      # unit tests; no network, no credentials
```

Layout: `config.py` (event facts, API version), `dates.py`, `images.py`, `client.py`
(HTTP), `auth.py` (OAuth and tokens), `events.py` (payloads, duplicate check, create),
`ledger.py`, `cli.py`. The runtime uses only the standard library; pytest is the only dev dependency.
