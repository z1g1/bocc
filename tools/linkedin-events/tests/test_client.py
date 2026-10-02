import json

import pytest

from bocc_events import config
from bocc_events.client import (
    ApiError,
    LinkedInClient,
    Response,
    UncertainResult,
    build_query,
    is_linkedin_url,
)

TOKEN = "secret-token-value"


class FakeTransport:
    """Records requests and replays canned responses (or raises queued exceptions)."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        self.calls.append({"method": method, "url": url, "headers": headers, "body": body})
        item = self.responses.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


def ok(payload=None, status=200, headers=None):
    return Response(status, headers or {}, json.dumps(payload or {}).encode())


def client_with(*responses):
    transport = FakeTransport(*responses)
    return LinkedInClient(TOKEN, transport=transport, sleep=lambda s: None), transport


def test_get_sends_versioned_headers():
    client, transport = client_with(ok({"elements": []}))
    assert client.get("/rest/events", "q=x") == {"elements": []}
    call = transport.calls[0]
    assert call["url"] == f"{config.API_BASE}/rest/events?q=x"
    assert call["headers"]["LinkedIn-Version"] == config.LINKEDIN_VERSION
    assert call["headers"]["X-Restli-Protocol-Version"] == "2.0.0"
    assert call["headers"]["Authorization"] == f"Bearer {TOKEN}"


def test_get_retries_transient_failures():
    client, transport = client_with(ok(status=503), TimeoutError(), ok({"done": True}))
    assert client.get("/rest/events") == {"done": True}
    assert len(transport.calls) == 3


def test_get_gives_up_after_max_attempts():
    client, _ = client_with(ok(status=503), ok(status=503), ok({"message": "down"}, status=503))
    with pytest.raises(ApiError, match="503"):
        client.get("/rest/events")


def test_post_is_never_retried():
    client, transport = client_with(ok(status=503))
    with pytest.raises(ApiError):
        client.post_json("/rest/events", {})
    assert len(transport.calls) == 1


def test_post_network_failure_is_uncertain():
    client, transport = client_with(TimeoutError())
    with pytest.raises(UncertainResult):
        client.post_json("/rest/events", {})
    assert len(transport.calls) == 1


def test_post_sets_restli_method_and_json():
    client, transport = client_with(ok({"id": 1}, status=201))
    client.post_json("/rest/events", {"a": 1}, restli_method="create")
    call = transport.calls[0]
    assert call["headers"]["X-RestLi-Method"] == "create"
    assert json.loads(call["body"]) == {"a": 1}


def test_errors_never_contain_the_token():
    body = {"message": "Not enough permissions", "serviceErrorCode": 100}
    client, _ = client_with(ok(body, status=403))
    with pytest.raises(ApiError) as excinfo:
        client.get("/rest/events")
    text = str(excinfo.value)
    assert TOKEN not in text
    assert "Not enough permissions" in text and "ADMINISTRATOR" in text
    assert TOKEN not in repr(client)


def test_error_bodies_are_truncated():
    client, _ = client_with(Response(500, {}, b"x" * 10_000), Response(500, {}, b"x" * 10_000), Response(500, {}, b"x" * 10_000))
    with pytest.raises(ApiError) as excinfo:
        client.get("/rest/events")
    assert len(str(excinfo.value)) < 400


@pytest.mark.parametrize(
    "url, allowed",
    [
        ("https://api.linkedin.com/mediaUpload/sp/x", True),
        ("https://www.linkedin.com/x", True),
        ("http://api.linkedin.com/x", False),
        ("https://api.linkedin-ei.com/x", False),
        ("https://linkedin.com.evil.example/x", False),
        ("https://evil.example/?h=api.linkedin.com", False),
    ],
)
def test_upload_url_allowlist(url, allowed):
    assert is_linkedin_url(url) is allowed


def test_upload_refuses_foreign_host():
    client, transport = client_with()
    with pytest.raises(ApiError, match="refusing"):
        client.upload("https://evil.example/upload", b"data", "image/png")
    assert transport.calls == []


def test_upload_sends_bytes_with_content_type():
    client, transport = client_with(Response(201, {}, b""))
    client.upload("https://api.linkedin.com/mediaUpload/x", b"bytes", "image/jpeg")
    call = transport.calls[0]
    assert call["body"] == b"bytes" and call["headers"]["Content-Type"] == "image/jpeg"


def test_build_query_leaves_restli_tuples_unencoded():
    query = build_query({"organizer": "urn:li:organization:1"}, {"timeBasedFilter": "(lifeCycleState:UPCOMING)"})
    assert query == "organizer=urn%3Ali%3Aorganization%3A1&timeBasedFilter=(lifeCycleState:UPCOMING)"
