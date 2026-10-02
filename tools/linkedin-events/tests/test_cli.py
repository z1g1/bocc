import json
from datetime import date, datetime, timedelta, timezone

import pytest

from bocc_events import auth, cli, events
from bocc_events.client import LinkedInClient, Response
from bocc_events.ledger import CREATED, PENDING, Ledger

FIXED_NOW = datetime(2026, 10, 2, 16, 0, tzinfo=timezone.utc)  # Friday
DAY = date(2026, 10, 6)


def resp(payload, status=200):
    return Response(status, {}, json.dumps(payload).encode())


REGISTER_OK = resp(
    {
        "value": {
            "asset": "urn:li:digitalmediaAsset:D55",
            "uploadMechanism": {
                "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest": {
                    "uploadUrl": "https://api.linkedin.com/mediaUpload/x"
                }
            },
        }
    }
)
NO_EVENTS = resp({"elements": []})
UPLOAD_OK = Response(201, {}, b"")
CREATE_OK = resp({"id": 7249812613549670400}, status=201)


class Transport:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append((method, url))
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Isolate token file, ledger and clock; give the CLI a valid saved token."""
    token_file = tmp_path / "token.env"
    monkeypatch.setenv("LINKEDIN_TOKEN_FILE", str(token_file))
    monkeypatch.setenv("LINKEDIN_LEDGER_FILE", str(tmp_path / "ledger.json"))
    monkeypatch.delenv("LINKEDIN_ACCESS_TOKEN", raising=False)
    monkeypatch.setattr(cli, "_now", lambda: FIXED_NOW)
    auth.save_credentials(
        auth.Credentials("tok", FIXED_NOW + timedelta(days=30), "urn:li:person:me"), token_file, FIXED_NOW
    )
    return tmp_path


@pytest.fixture
def transport(monkeypatch):
    holder = {}

    def install(*responses):
        holder["t"] = Transport(*responses)
        monkeypatch.setattr(cli, "LinkedInClient", lambda token: LinkedInClient(token, transport=holder["t"], sleep=lambda s: None))
        return holder["t"]

    return install


def ledger(env):
    return Ledger(env / "ledger.json")


def test_dry_run_is_default_and_offline(env, transport, monkeypatch, capsys):
    monkeypatch.delenv("LINKEDIN_TOKEN_FILE")  # no credentials needed at all
    t = transport()
    assert cli.main(["create"]) == 0
    out = capsys.readouterr().out
    assert "Buffalo Open Coffee Club for 10/6" in out
    assert '"discoveryMode": "LISTED"' in out
    assert "Dry run: nothing was sent" in out
    assert t.calls == []


def test_dry_run_rejects_non_tuesday(env, capsys):
    assert cli.main(["create", "--date", "2026-10-07"]) == 1
    assert "not a Tuesday" in capsys.readouterr().err


def test_live_create_full_flow(env, transport, capsys):
    t = transport(NO_EVENTS, REGISTER_OK, UPLOAD_OK, CREATE_OK)
    assert cli.main(["create", "--live", "--yes"]) == 0
    assert [c[0] for c in t.calls] == ["GET", "POST", "POST", "POST"]
    assert t.calls[3][1].endswith("/rest/events")
    entry = ledger(env).get(DAY)
    assert entry["status"] == CREATED and entry["event_id"] == "7249812613549670400"
    assert "linkedin.com/events/7249812613549670400/" in capsys.readouterr().out


def test_live_create_is_blocked_by_ledger(env, transport, capsys):
    ledger(env).record_created(DAY, "1", events.event_url("1"), FIXED_NOW)
    t = transport()
    assert cli.main(["create", "--live", "--yes"]) == 1
    assert t.calls == []
    assert "Already created" in capsys.readouterr().err


def test_live_create_is_blocked_by_existing_linkedin_event(env, transport, capsys):
    spec = events.build_spec(DAY)
    existing = {"id": 9, "name": {"localized": {"en_US": spec.name}}, "startsAt": spec.starts_at_ms}
    t = transport(resp({"elements": [existing]}))
    assert cli.main(["create", "--live", "--yes"]) == 1
    assert len(t.calls) == 1
    assert "already has a matching event" in capsys.readouterr().err


def test_rejected_create_clears_pending(env, transport):
    transport(NO_EVENTS, resp({"message": "bad"}, status=422))
    assert cli.main(["create", "--live", "--yes", "--no-image"]) == 1
    assert ledger(env).get(DAY) is None


def test_uncertain_create_leaves_pending(env, transport, capsys):
    transport(NO_EVENTS, TimeoutError())
    assert cli.main(["create", "--live", "--yes", "--no-image"]) == 1
    assert ledger(env).get(DAY)["status"] == PENDING
    assert "may have been created" in capsys.readouterr().err


def test_live_without_tty_requires_yes(env, transport, monkeypatch, capsys):
    monkeypatch.setattr("sys.stdin.isatty", lambda: False)
    t = transport(NO_EVENTS)
    assert cli.main(["create", "--live", "--no-image"]) == 1
    assert len(t.calls) == 1  # only the read-only duplicate check ran
    assert ledger(env).get(DAY) is None


def test_expired_token_fails_loudly(env, transport, capsys):
    auth.save_credentials(auth.Credentials("tok", FIXED_NOW - timedelta(days=1), None), env / "token.env", FIXED_NOW)
    t = transport()
    assert cli.main(["create", "--live", "--yes"]) == 1
    assert "expired" in capsys.readouterr().err
    assert t.calls == []


def test_forget(env, capsys):
    ledger(env).record_pending(DAY, "x", FIXED_NOW)
    assert cli.main(["forget", "--date", "2026-10-06"]) == 0
    assert ledger(env).get(DAY) is None
    assert cli.main(["forget", "--date", "2026-10-06"]) == 1


def test_check_lists_events(env, transport, capsys):
    transport(resp({"elements": [{"id": 5, "name": {"localized": {"en_US": "BOCC"}}, "startsAt": 1791286200000}]}))
    assert cli.main(["check"]) == 0
    out = capsys.readouterr().out
    assert "1 upcoming" in out and "2026-10-06  BOCC" in out


def test_cover_upload_403_explains_no_image(env, transport, capsys):
    t = transport(NO_EVENTS, resp({"message": "Not enough permissions", "serviceErrorCode": 100}, status=403))
    assert cli.main(["create", "--live", "--yes"]) == 1
    err = capsys.readouterr().err
    assert "--no-image" in err and "nothing was created" in err
    assert len(t.calls) == 2  # duplicate check + registerUpload; no create attempted
    assert ledger(env).get(DAY) is None
