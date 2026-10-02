"""One-time OAuth 2.0 setup and access-token handling.

Flow (3-legged authorization code, run by a page admin):
1. We print LinkedIn's authorization URL with a random `state`.
2. The admin approves in a browser. LinkedIn redirects to REDIRECT_URI, which
   nothing serves (this tool runs on a remote host), so the browser shows an
   error page. The admin copies the URL from the address bar and pastes it back.
3. We check the pasted URL's origin, path and `state` (constant-time compare),
   exchange the code for a token, and write it to a 0600 env file outside the repo.

LinkedIn's standard web flow doesn't support PKCE (only the native-app flow
does, with LinkedIn enabling it per app), so `state` plus the confidential
client secret is the protection here.

At runtime the token comes from the environment (LINKEDIN_ACCESS_TOKEN etc.,
e.g. a CI secret) or, if that's unset, the token file. Member tokens last
60 days. Refresh tokens are documented only for approved partners, so the
normal path is to rerun `bocc-event auth`. We warn a week ahead and fail
loudly once the token expires.
"""

import hmac
import os
import secrets
import shlex
import stat
import tempfile
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .client import Response, Transport, describe_error, urllib_transport

AUTHORIZE_URL = "https://www.linkedin.com/oauth/v2/authorization"
TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken"
USERINFO_URL = "https://api.linkedin.com/v2/userinfo"

# Minimum scopes:
# - r_events / rw_events (Event Management API): list and create events.
# - openid + profile (Sign In with LinkedIn using OpenID Connect): only to learn
#   the admin's member ID, which registerUpload needs as the cover image owner.
#   LinkedIn rejects openid alone ("openid_insufficient_scope_error"); profile
#   (name/photo) is the less sensitive companion, versus email.
SCOPES = ("r_events", "rw_events", "openid", "profile")
DEFAULT_REDIRECT_URI = "http://localhost:8765/callback"
EXPIRY_WARNING = timedelta(days=7)

TOKEN_KEYS = (
    "LINKEDIN_ACCESS_TOKEN",
    "LINKEDIN_TOKEN_EXPIRES_AT",
    "LINKEDIN_PERSON_URN",
    "LINKEDIN_REFRESH_TOKEN",
    "LINKEDIN_REFRESH_EXPIRES_AT",
)


class AuthError(Exception):
    """Missing, invalid or expired credentials. The message says how to fix it."""


REAUTH_HINT = "Run `bocc-event auth` (needs LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET) to get a new token."


@dataclass(frozen=True)
class Credentials:
    access_token: str
    expires_at: datetime | None
    person_urn: str | None
    refresh_token: str | None = None
    refresh_expires_at: datetime | None = None

    def __repr__(self) -> str:  # keep tokens out of tracebacks and debug prints
        return f"Credentials(expires_at={self.expires_at}, person_urn={self.person_urn!r}, <tokens redacted>)"


# --- Paths and client config -------------------------------------------------


def token_file_path(env=os.environ) -> Path:
    if env.get("LINKEDIN_TOKEN_FILE"):
        return Path(env["LINKEDIN_TOKEN_FILE"]).expanduser()
    base = Path(env.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    return base / "bocc-linkedin" / "token.env"


def client_config(env=os.environ) -> tuple[str, str, str]:
    """Return (client_id, client_secret, redirect_uri) from the environment."""
    client_id = env.get("LINKEDIN_CLIENT_ID", "").strip()
    client_secret = env.get("LINKEDIN_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        raise AuthError("Set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET (from your LinkedIn app's Auth tab).")
    return client_id, client_secret, env.get("LINKEDIN_REDIRECT_URI", DEFAULT_REDIRECT_URI)


# --- Authorization request and callback --------------------------------------


def new_state() -> str:
    return secrets.token_urlsafe(32)


def authorization_url(client_id: str, redirect_uri: str, state: str, scopes=SCOPES) -> str:
    query = urllib.parse.urlencode(
        {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "state": state,
            "scope": " ".join(scopes),
        },
        quote_via=urllib.parse.quote,
    )
    return f"{AUTHORIZE_URL}?{query}"


def parse_callback(pasted_url: str, expected_state: str, redirect_uri: str) -> str:
    """Validate the pasted redirect URL and return the authorization code."""
    got = urllib.parse.urlsplit(pasted_url.strip())
    want = urllib.parse.urlsplit(redirect_uri)
    if (got.scheme, got.netloc, got.path) != (want.scheme, want.netloc, want.path):
        raise AuthError(f"That URL doesn't match the redirect URI {redirect_uri}.")
    params = urllib.parse.parse_qs(got.query)

    state = params.get("state", [""])[0]
    # Check state before anything else, including error reporting, so a forged
    # callback can't inject messages. compare_digest avoids timing leaks.
    if not hmac.compare_digest(state.encode(), expected_state.encode()):
        raise AuthError("OAuth state mismatch: the callback is not from this login attempt. Start over.")
    if "error" in params:
        desc = params.get("error_description", [""])[0][:200]
        raise AuthError(f"LinkedIn denied authorization: {params['error'][0][:50]} {desc}")
    code = params.get("code", [""])[0]
    if not code:
        raise AuthError("The callback URL has no authorization code.")
    return code


# --- Token endpoint ------------------------------------------------------------


def _token_request(form: dict[str, str], transport: Transport) -> dict:
    body = urllib.parse.urlencode(form).encode()
    headers = {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}
    try:
        resp: Response = transport("POST", TOKEN_URL, headers, body, 30)
    except OSError as err:
        raise AuthError(f"Could not reach LinkedIn's token endpoint ({type(err).__name__}).") from None
    if resp.status != 200:
        raise AuthError(f"Token request failed: {describe_error(resp)}")
    return resp.json()


def _credentials_from_token_response(data: dict, now: datetime, person_urn: str | None) -> Credentials:
    if not data.get("access_token") or not data.get("expires_in"):
        raise AuthError("LinkedIn's token response was missing access_token or expires_in.")
    refresh_expires = data.get("refresh_token_expires_in")
    return Credentials(
        access_token=data["access_token"],
        expires_at=now + timedelta(seconds=int(data["expires_in"])),
        person_urn=person_urn,
        refresh_token=data.get("refresh_token"),
        refresh_expires_at=now + timedelta(seconds=int(refresh_expires)) if refresh_expires else None,
    )


def missing_scopes(data: dict) -> list[str]:
    """Scopes we asked for that LinkedIn didn't grant (e.g. product not added to the app)."""
    granted = set(data.get("scope", "").replace(",", " ").split())
    return [s for s in SCOPES if s not in granted] if granted else []


def exchange_code(code: str, client_id: str, client_secret: str, redirect_uri: str,
                  now: datetime, transport: Transport = urllib_transport) -> tuple[Credentials, dict]:
    """Trade the authorization code for tokens; also fetch the admin's person URN."""
    data = _token_request(
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": client_id,
            "client_secret": client_secret,
        },
        transport,
    )
    creds = _credentials_from_token_response(data, now, None)
    person_urn = fetch_person_urn(creds.access_token, transport)
    return Credentials(**{**creds.__dict__, "person_urn": person_urn}), data


def refresh(creds: Credentials, client_id: str, client_secret: str, now: datetime,
            transport: Transport = urllib_transport) -> Credentials:
    """Use a programmatic refresh token, if LinkedIn granted one."""
    if not creds.refresh_token:
        raise AuthError("No refresh token was granted for this app. " + REAUTH_HINT)
    if creds.refresh_expires_at and creds.refresh_expires_at <= now:
        raise AuthError("The refresh token has expired. " + REAUTH_HINT)
    data = _token_request(
        {
            "grant_type": "refresh_token",
            "refresh_token": creds.refresh_token,
            "client_id": client_id,
            "client_secret": client_secret,
        },
        transport,
    )
    return _credentials_from_token_response(data, now, creds.person_urn)


def fetch_person_urn(access_token: str, transport: Transport = urllib_transport) -> str:
    """Read the member ID (`sub`) from the OpenID Connect userinfo endpoint."""
    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}
    try:
        resp = transport("GET", USERINFO_URL, headers, None, 30)
    except OSError as err:
        raise AuthError(f"Could not reach LinkedIn userinfo ({type(err).__name__}).") from None
    if resp.status != 200:
        raise AuthError(
            f"userinfo failed: {describe_error(resp)}. Is 'Sign In with LinkedIn using OpenID Connect' added to the app?"
        )
    sub = resp.json().get("sub", "")
    # Member IDs are short URL-safe strings; reject anything else before it lands in a payload.
    if not sub or not all(c.isalnum() or c in "-_" for c in sub):
        raise AuthError("userinfo returned an unexpected member ID.")
    return f"urn:li:person:{sub}"


# --- Storage -------------------------------------------------------------------


def _to_env(creds: Credentials) -> dict[str, str]:
    values = {
        "LINKEDIN_ACCESS_TOKEN": creds.access_token,
        "LINKEDIN_TOKEN_EXPIRES_AT": creds.expires_at.isoformat() if creds.expires_at else "",
        "LINKEDIN_PERSON_URN": creds.person_urn or "",
        "LINKEDIN_REFRESH_TOKEN": creds.refresh_token or "",
        "LINKEDIN_REFRESH_EXPIRES_AT": creds.refresh_expires_at.isoformat() if creds.refresh_expires_at else "",
    }
    return {k: v for k, v in values.items() if v}


def save_credentials(creds: Credentials, path: Path, now: datetime) -> None:
    """Write a shell-sourceable env file, readable only by this user, atomically."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    lines = [f"# Written by `bocc-event auth` at {now.isoformat()}. Secret: never commit or share."]
    lines += [f"export {k}={shlex.quote(v)}" for k, v in _to_env(creds).items()]
    # mkstemp creates the file 0600 in the same directory, so os.replace is atomic
    # and the token is never briefly world-readable.
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".token-")
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write("\n".join(lines) + "\n")
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise


def _parse_env_file(path: Path) -> dict[str, str]:
    mode = path.stat().st_mode
    if mode & (stat.S_IRWXG | stat.S_IRWXO):
        raise AuthError(f"{path} is accessible by other users; run `chmod 600 {path}`.")
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        tokens = shlex.split(line)  # parsed, never executed
        if tokens and tokens[0] == "export":
            tokens = tokens[1:]
        if len(tokens) == 1 and "=" in tokens[0]:
            key, value = tokens[0].split("=", 1)
            if key in TOKEN_KEYS:
                values[key] = value
    return values


def _parse_time(raw: str | None, key: str) -> datetime | None:
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        raise AuthError(f"{key} is not an ISO-8601 timestamp.") from None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def load_credentials(env=os.environ) -> tuple[Credentials, str]:
    """Return (credentials, source). Env vars win over the token file; the two are never mixed."""
    if env.get("LINKEDIN_ACCESS_TOKEN"):
        values, source = {k: env[k] for k in TOKEN_KEYS if env.get(k)}, "environment"
    else:
        path = token_file_path(env)
        if not path.exists():
            raise AuthError(f"No LinkedIn token in the environment or at {path}. " + REAUTH_HINT)
        values, source = _parse_env_file(path), str(path)
        if not values.get("LINKEDIN_ACCESS_TOKEN"):
            raise AuthError(f"{path} has no LINKEDIN_ACCESS_TOKEN. " + REAUTH_HINT)
    creds = Credentials(
        access_token=values["LINKEDIN_ACCESS_TOKEN"],
        expires_at=_parse_time(values.get("LINKEDIN_TOKEN_EXPIRES_AT"), "LINKEDIN_TOKEN_EXPIRES_AT"),
        person_urn=values.get("LINKEDIN_PERSON_URN"),
        refresh_token=values.get("LINKEDIN_REFRESH_TOKEN"),
        refresh_expires_at=_parse_time(values.get("LINKEDIN_REFRESH_EXPIRES_AT"), "LINKEDIN_REFRESH_EXPIRES_AT"),
    )
    return creds, source


def check_expiry(creds: Credentials, now: datetime) -> str | None:
    """Raise if expired; return a warning string if expiring soon or unknown."""
    if creds.expires_at is None:
        return "Token expiry is unknown (LINKEDIN_TOKEN_EXPIRES_AT unset); it may stop working without notice."
    if creds.expires_at <= now:
        hint = " Or run `bocc-event auth --refresh`." if creds.refresh_token else ""
        raise AuthError(f"The LinkedIn token expired at {creds.expires_at:%Y-%m-%d %H:%M %Z}. {REAUTH_HINT}{hint}")
    remaining = creds.expires_at - now
    if remaining <= EXPIRY_WARNING:
        return f"The LinkedIn token expires in {remaining.days} day(s) ({creds.expires_at:%Y-%m-%d}). Re-run `bocc-event auth` soon."
    return None

