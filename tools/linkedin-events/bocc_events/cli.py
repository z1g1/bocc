"""`bocc-event` command line.

    bocc-event auth [--refresh]       one-time OAuth setup (or refresh, if LinkedIn granted one)
    bocc-event check                  prove the token and page access by listing upcoming events
    bocc-event create [options]       dry-run by default; --live to create on LinkedIn
    bocc-event forget --date DATE     clear a ledger entry after checking LinkedIn by hand

`create` never posts the event. LinkedIn only lets an app post as a page with
Community Management API access, so the admin opens the printed link and
publishes it from LinkedIn.
"""

import argparse
import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path

from . import auth, config, events
from .client import ApiError, LinkedInClient, UncertainResult
from .dates import DateError, resolve_event_date
from .images import CoverImage, ImageError, load_cover_image
from .ledger import CREATED, Ledger, default_path

ASSET_PLACEHOLDER = "<urn:li:digitalmediaAsset from registerUpload>"
OWNER_PLACEHOLDER = "<your urn:li:person from `bocc-event auth`>"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _warn(message: str) -> None:
    print(f"warning: {message}", file=sys.stderr)


def _dump(title: str, payload: dict) -> None:
    print(f"\n--- {title} ---")
    print(json.dumps(payload, indent=2))


def _authed_client(now: datetime) -> tuple[LinkedInClient, auth.Credentials]:
    creds, source = auth.load_credentials()
    if warning := auth.check_expiry(creds, now):
        _warn(warning)
    print(f"Using LinkedIn token from {source}.")
    return LinkedInClient(creds.access_token), creds


# --- auth ------------------------------------------------------------------------


def cmd_auth(args) -> int:
    client_id, client_secret, redirect_uri = auth.client_config()
    path = auth.token_file_path()
    now = _now()

    if args.refresh:
        creds, _ = auth.load_credentials()
        creds = auth.refresh(creds, client_id, client_secret, now)
    else:
        state = auth.new_state()
        print("1. Open this URL in a browser signed in as a BOCC page admin and approve access:\n")
        print(f"   {auth.authorization_url(client_id, redirect_uri, state)}\n")
        print(f"2. LinkedIn redirects to {redirect_uri}. The page won't load; that's expected.")
        print("   Copy the full URL from the address bar and paste it here.\n")
        pasted = input("Redirect URL: ")
        code = auth.parse_callback(pasted, state, redirect_uri)
        creds, token_data = auth.exchange_code(code, client_id, client_secret, redirect_uri, now)
        if missing := auth.missing_scopes(token_data):
            _warn(f"LinkedIn did not grant {', '.join(missing)}; check the app's Products tab.")

    auth.save_credentials(creds, path, now)
    print(f"\nSaved token to {path} (mode 0600). It expires {creds.expires_at:%Y-%m-%d}.")
    print(f"Member: {creds.person_urn}. Refresh token granted: {'yes' if creds.refresh_token else 'no'}.")
    print("Load it into a shell with:  set -a; . " + str(path) + "; set +a")
    return 0


# --- check -----------------------------------------------------------------------


def cmd_check(args) -> int:
    client, creds = _authed_client(_now())
    upcoming = events.list_upcoming_events(client)
    print(f"Organizer {config.ORGANIZER_URN}: {len(upcoming)} upcoming posted event(s).")
    for event in upcoming:
        print(f"  {events.event_day(event)}  {events.event_name(event)}  {events.event_url(event)}")
    if not creds.person_urn:
        _warn("No LINKEDIN_PERSON_URN; cover image uploads will fail. Re-run `bocc-event auth`.")
    return 0


# --- create ------------------------------------------------------------------------


def _print_plan(spec: events.EventSpec, image: CoverImage | None) -> None:
    print(f"Event:    {spec.name}")
    print(f"When:     {spec.day:%A %Y-%m-%d}, {config.EVENT_START:%-I:%M}-{config.EVENT_END:%-I:%M} AM Eastern")
    print(f"Organizer {config.ORGANIZER_URN}, discovery {spec.discovery_mode}")
    if image:
        print(f"Cover:    {image.path} ({image.content_type}, {image.width}x{image.height})")
        for warning in image.warnings:
            _warn(warning)
    else:
        print("Cover:    none (LinkedIn default)")


def _confirm(spec: events.EventSpec) -> bool:
    if not sys.stdin.isatty():
        print("Refusing to create without a terminal to confirm; pass --yes for unattended runs.", file=sys.stderr)
        return False
    answer = input(f"\nCreate '{spec.name}' on LinkedIn? Type 'yes' to continue: ")
    return answer.strip().lower() == "yes"


def cmd_create(args) -> int:
    now = _now()
    day = resolve_event_date(args.date, now)
    image = None if args.no_image else load_cover_image(Path(args.image) if args.image else config.DEFAULT_IMAGE)
    spec = events.build_spec(day, events.URL_ONLY if args.url_only else events.LISTED)
    _print_plan(spec, image)

    if not args.live:
        # Dry run: no credentials are read and nothing touches the network.
        if image:
            _dump("POST /rest/assets?action=registerUpload", events.build_register_upload_payload(OWNER_PLACEHOLDER))
            print(f"\n--- POST <uploadUrl>: {len(image.data):,} bytes of {image.content_type} ---")
        _dump("POST /rest/events", events.build_event_payload(spec, ASSET_PLACEHOLDER if image else None))
        print("\nDry run: nothing was sent. Re-run with --live to create the event.")
        return 0

    client, creds = _authed_client(now)
    if image and not creds.person_urn:
        raise auth.AuthError("Uploading a cover needs LINKEDIN_PERSON_URN. Re-run `bocc-event auth` or pass --no-image.")

    # Duplicate guard 1: our own record of attempts (works even for unposted events).
    ledger = Ledger(default_path())
    if entry := ledger.get(day):
        where = entry.get("url") or "unknown (the create request may not have finished)"
        print(f"Already {entry['status']} for {day}: {where}", file=sys.stderr)
        if entry["status"] != CREATED:
            print(f"Check the page's events on LinkedIn, then run `bocc-event forget --date {day}` to retry.", file=sys.stderr)
        return 1

    # Duplicate guard 2: what LinkedIn reports for the page.
    if dupes := events.find_duplicates(events.list_upcoming_events(client), spec):
        print("LinkedIn already has a matching event; not creating another:", file=sys.stderr)
        for event in dupes:
            print(f"  {events.event_day(event)}  {events.event_name(event)}  {events.event_url(event)}", file=sys.stderr)
        return 1

    if not args.yes and not _confirm(spec):
        print("Cancelled; nothing was created.")
        return 1

    asset = None
    if image:
        try:
            upload_url, asset = events.register_upload(client, creds.person_urn)
        except ApiError as err:
            if err.status != 403:
                raise
            # The Assets API needs w_member_social (Share on LinkedIn) or
            # w_organization_social; Event Management's rw_events doesn't cover it.
            raise ApiError(
                403,
                "LinkedIn refused the cover upload (needs w_member_social). Check the app has the"
                " 'Share on LinkedIn' product and re-run `bocc-event auth`, or use --no-image."
                " Nothing was created.",
            ) from None
        client.upload(upload_url, image.data, image.content_type)
        print(f"Uploaded cover image ({asset}).")

    ledger.record_pending(day, spec.name, now)
    try:
        created = events.create_event(client, events.build_event_payload(spec, asset))
    except ApiError:
        ledger.forget(day)  # LinkedIn rejected it outright, so nothing exists and retrying is safe.
        raise
    # UncertainResult propagates with the ledger left at `pending` on purpose.

    url = events.event_url(created)
    ledger.record_created(day, created["id"], url, now)
    print(f"\nCreated (not yet published): {url}")
    print("Next: open the link as a page admin and post it as the BOCC page, then reshare it from your profile")
    print("with: Please join me at Buffalo Open Coffee Club")
    return 0


# --- forget ---------------------------------------------------------------------------


def cmd_forget(args) -> int:
    day = date.fromisoformat(args.date)
    if Ledger(default_path()).forget(day):
        print(f"Removed the ledger entry for {day}. The next `create --live` will try again.")
        return 0
    print(f"No ledger entry for {day}.")
    return 1


# --- entry point ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="bocc-event", description="Create the weekly BOCC LinkedIn event.")
    sub = parser.add_subparsers(dest="command", required=True)

    p_auth = sub.add_parser("auth", help="one-time OAuth setup; writes a 0600 token file")
    p_auth.add_argument("--refresh", action="store_true", help="use a stored refresh token instead of a browser login")
    p_auth.set_defaults(func=cmd_auth)

    p_check = sub.add_parser("check", help="verify the token and list upcoming events on the page")
    p_check.set_defaults(func=cmd_check)

    p_create = sub.add_parser("create", help="build (and with --live, create) the event")
    p_create.add_argument("--date", help="event date, YYYY-MM-DD (a Tuesday; default: next Tuesday)")
    image = p_create.add_mutually_exclusive_group()
    image.add_argument("--image", help="cover photo, PNG or JPEG (default: default-bocc-image.png)")
    image.add_argument("--no-image", action="store_true", help="use LinkedIn's default cover")
    p_create.add_argument("--url-only", action="store_true", help="unlisted: reachable only by link (for tests)")
    p_create.add_argument("--live", action="store_true", help="actually call LinkedIn (default is a dry run)")
    p_create.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    p_create.set_defaults(func=cmd_create)

    p_forget = sub.add_parser("forget", help="clear the local ledger entry for a date")
    p_forget.add_argument("--date", required=True, help="YYYY-MM-DD")
    p_forget.set_defaults(func=cmd_forget)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except UncertainResult as err:
        print(f"error: {err}", file=sys.stderr)
        print("The event may have been created. Check the page's events on LinkedIn before retrying;", file=sys.stderr)
        print("then run `bocc-event forget --date ...` if it wasn't.", file=sys.stderr)
        return 1
    except (auth.AuthError, ApiError, DateError, ImageError, ValueError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    except (KeyboardInterrupt, EOFError):
        print("\nAborted.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
