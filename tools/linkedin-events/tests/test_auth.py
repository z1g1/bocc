import json
import os
import urllib.parse
from datetime import datetime, timedelta, timezone

import pytest

from bocc_events import auth
from bocc_events.auth import AuthError, Credentials
from bocc_events.client import Response

NOW = datetime(2026, 10, 2, 12, 0, tzinfo=timezone.utc)
REDIRECT = auth.DEFAULT_REDIRECT_URI
STATE = "expected-state-value"


def callback(**params):
    return f"{REDIRECT}?{urllib.parse.urlencode(params)}"


# --- authorization URL and callback ---------------------------------------------


def test_authorization_url_requests_minimum_scopes():
    url = auth.authorization_url("client-123", REDIRECT, STATE)
    params = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
    assert url.startswith(auth.AUTHORIZE_URL)
    assert params["scope"] == ["r_events rw_events openid"]
    assert params["state"] == [STATE]
    assert params["redirect_uri"] == [REDIRECT]
    assert params["response_type"] == ["code"]


def test_new_state_is_random_and_long():
    a, b = auth.new_state(), auth.new_state()
    assert a != b and len(a) >= 40


def test_parse_callback_returns_code():
    assert auth.parse_callback(callback(code="abc", state=STATE), STATE, REDIRECT) == "abc"


@pytest.mark.parametrize(
    "url, message",
    [
        (callback(code="abc", state="wrong"), "state mismatch"),
        (callback(code="abc"), "state mismatch"),
        ("https://evil.example/callback?code=abc&state=" + STATE, "doesn't match"),
        ("http://localhost:8765/other?code=abc&state=" + STATE, "doesn't match"),
        (callback(state=STATE), "no authorization code"),
        (callback(error="user_cancelled_login", state=STATE), "denied"),
    ],
)
def test_parse_callback_rejects(url, message):
    with pytest.raises(AuthError, match=message):
        auth.parse_callback(url, STATE, REDIRECT)


def test_forged_error_callback_fails_on_state_first():
    with pytest.raises(AuthError, match="state mismatch"):
        auth.parse_callback(callback(error="x", error_description="call 555-scam"), STATE, REDIRECT)


def test_client_config_requires_both_values():
    with pytest.raises(AuthError):
        auth.client_config({"LINKEDIN_CLIENT_ID": "id"})
    assert auth.client_config({"LINKEDIN_CLIENT_ID": "id", "LINKEDIN_CLIENT_SECRET": "s"}) == ("id", "s", REDIRECT)


# --- token exchange ----------------------------------------------------------------


class Transport:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append((method, url, headers, body))
        return self.responses.pop(0)


def json_response(status, payload):
    return Response(status, {}, json.dumps(payload).encode())


def test_exchange_code_builds_credentials():
    transport = Transport(
        json_response(200, {"access_token": "tok", "expires_in": 5184000, "scope": "r_events,rw_events,openid"}),
        json_response(200, {"sub": "AbC-123_x"}),
    )
    creds, data = auth.exchange_code("code", "id", "secret", REDIRECT, NOW, transport)
    assert creds.access_token == "tok"
    assert creds.expires_at == NOW + timedelta(days=60)
    assert creds.person_urn == "urn:li:person:AbC-123_x"
    assert auth.missing_scopes(data) == []
    form = urllib.parse.parse_qs(transport.calls[0][3].decode())
    assert form["grant_type"] == ["authorization_code"] and form["redirect_uri"] == [REDIRECT]
    assert transport.calls[1][2]["Authorization"] == "Bearer tok"


def test_exchange_code_surfaces_errors_without_secret():
    transport = Transport(json_response(400, {"error": "invalid_request", "error_description": "bad code"}))
    with pytest.raises(AuthError) as excinfo:
        auth.exchange_code("code", "id", "client-secret-value", REDIRECT, NOW, transport)
    assert "bad code" in str(excinfo.value) and "client-secret-value" not in str(excinfo.value)


def test_rejects_suspicious_member_id():
    transport = Transport(json_response(200, {"sub": "x,urn:li:organization:1"}))
    with pytest.raises(AuthError, match="unexpected member ID"):
        auth.fetch_person_urn("tok", transport)


def test_missing_scopes_detects_ungranted_products():
    assert auth.missing_scopes({"scope": "r_events,rw_events"}) == ["openid"]


def test_refresh_requires_refresh_token():
    creds = Credentials("tok", NOW, "urn:li:person:a")
    with pytest.raises(AuthError, match="No refresh token"):
        auth.refresh(creds, "id", "secret", NOW, Transport())


def test_refresh_keeps_person_urn():
    creds = Credentials("old", NOW, "urn:li:person:a", refresh_token="r", refresh_expires_at=NOW + timedelta(days=1))
    transport = Transport(json_response(200, {"access_token": "new", "expires_in": 3600}))
    fresh = auth.refresh(creds, "id", "secret", NOW, transport)
    assert (fresh.access_token, fresh.person_urn) == ("new", "urn:li:person:a")


# --- storage and loading -------------------------------------------------------------


def test_save_and_load_round_trip(tmp_path):
    path = tmp_path / "cfg" / "token.env"
    creds = Credentials("tok'en $(rm -rf ~)", NOW + timedelta(days=60), "urn:li:person:a")
    auth.save_credentials(creds, path, NOW)
    assert path.stat().st_mode & 0o777 == 0o600
    assert path.parent.stat().st_mode & 0o777 == 0o700
    loaded, source = auth.load_credentials({"LINKEDIN_TOKEN_FILE": str(path)})
    assert loaded.access_token == creds.access_token
    assert loaded.expires_at == creds.expires_at
    assert loaded.person_urn == "urn:li:person:a"
    assert source == str(path)


def test_load_refuses_group_readable_file(tmp_path):
    path = tmp_path / "token.env"
    auth.save_credentials(Credentials("tok", NOW, None), path, NOW)
    os.chmod(path, 0o644)
    with pytest.raises(AuthError, match="chmod 600"):
        auth.load_credentials({"LINKEDIN_TOKEN_FILE": str(path)})


def test_environment_wins_over_file(tmp_path):
    path = tmp_path / "token.env"
    auth.save_credentials(Credentials("file-token", NOW, None), path, NOW)
    creds, source = auth.load_credentials(
        {"LINKEDIN_TOKEN_FILE": str(path), "LINKEDIN_ACCESS_TOKEN": "env-token", "LINKEDIN_TOKEN_EXPIRES_AT": "2026-12-01T00:00:00+00:00"}
    )
    assert (creds.access_token, source) == ("env-token", "environment")


def test_load_without_any_token_explains_fix(tmp_path):
    with pytest.raises(AuthError, match="bocc-event auth"):
        auth.load_credentials({"LINKEDIN_TOKEN_FILE": str(tmp_path / "missing.env")})


def test_credentials_repr_hides_tokens():
    creds = Credentials("tok-secret", NOW, None, refresh_token="refresh-secret")
    assert "tok-secret" not in repr(creds) and "refresh-secret" not in repr(creds)


@pytest.mark.parametrize(
    "expires_at, outcome",
    [
        (NOW + timedelta(days=30), None),
        (NOW + timedelta(days=3), "expires in 3 day"),
        (None, "unknown"),
    ],
)
def test_check_expiry_warnings(expires_at, outcome):
    warning = auth.check_expiry(Credentials("t", expires_at, None), NOW)
    assert warning is None if outcome is None else outcome in warning


def test_check_expiry_fails_loudly_when_expired():
    with pytest.raises(AuthError, match="expired"):
        auth.check_expiry(Credentials("t", NOW - timedelta(seconds=1), None), NOW)
