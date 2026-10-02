"""Thin LinkedIn REST client on the standard library.

Security properties this module is responsible for:
- The bearer token only ever goes to https://*.linkedin.com. Redirects are not
  followed (urllib would otherwise forward the Authorization header), and
  upload URLs returned by the API are checked against an allowlist.
- Errors never include request headers, and response bodies are truncated, so
  tokens can't leak into logs or tracebacks.
- Only GETs are retried. A create that fails mid-flight raises UncertainResult
  instead of retrying, so we can never post the same event twice.
"""

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass

from . import config

TIMEOUT_SECONDS = 30
MAX_RESPONSE_BYTES = 5 * 1024 * 1024
RETRYABLE_STATUSES = {429, 500, 502, 503, 504}
ERROR_SNIPPET_CHARS = 300


@dataclass(frozen=True)
class Response:
    status: int
    headers: dict[str, str]  # lower-cased names
    body: bytes

    def json(self):
        return json.loads(self.body) if self.body else {}


# (method, url, headers, body, timeout) -> Response. Injected so tests never touch the network.
Transport = Callable[[str, str, dict[str, str], bytes | None, float], Response]


class ApiError(Exception):
    """LinkedIn returned a non-2xx response."""

    def __init__(self, status: int, message: str):
        self.status = status
        super().__init__(f"LinkedIn API error {status}: {message}")


class UncertainResult(Exception):
    """A non-idempotent request may or may not have been applied (network failure mid-request)."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Surface 3xx as errors rather than replaying the request (and its token) elsewhere."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_opener = urllib.request.build_opener(_NoRedirect)


def urllib_transport(method, url, headers, body, timeout) -> Response:
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with _opener.open(request, timeout=timeout) as resp:
            return Response(resp.status, _lower(resp.headers), resp.read(MAX_RESPONSE_BYTES))
    except urllib.error.HTTPError as err:
        return Response(err.code, _lower(err.headers), err.read(MAX_RESPONSE_BYTES))


def _lower(headers) -> dict[str, str]:
    return {k.lower(): v for k, v in headers.items()} if headers else {}


def is_linkedin_url(url: str) -> bool:
    """True only for https URLs on linkedin.com or a subdomain of it."""
    parts = urllib.parse.urlsplit(url)
    host = (parts.hostname or "").lower()
    return parts.scheme == "https" and (host == "linkedin.com" or host.endswith(".linkedin.com"))


def describe_error(resp: Response) -> str:
    """Pull LinkedIn's error message out of a response body, truncated and without headers."""
    try:
        body = resp.json()
        message = body.get("message") or body.get("error_description") or body.get("error")
        code = body.get("serviceErrorCode")
        detail = f"{message} (serviceErrorCode {code})" if code else str(message)
    except (ValueError, AttributeError):
        detail = resp.body.decode("utf-8", "replace")
    detail = detail[:ERROR_SNIPPET_CHARS]
    if resp.status == 401:
        detail += " -- the access token is invalid or expired; run `bocc-event auth`"
    elif resp.status == 403:
        detail += (
            " -- check the app has the Event Management product and your account is an"
            " ADMINISTRATOR or CONTENT_ADMINISTRATOR of the page"
        )
    return detail


def build_query(params: dict[str, str], raw: dict[str, str] | None = None) -> str:
    """URL-encode `params`; append `raw` verbatim (Rest.li tuples like (lifeCycleState:UPCOMING)
    must not be encoded, per the Events API docs). Raw values are code constants, never user input."""
    parts = [urllib.parse.urlencode(params)] if params else []
    parts += [f"{k}={v}" for k, v in (raw or {}).items()]
    return "&".join(parts)


class LinkedInClient:
    def __init__(
        self,
        access_token: str,
        transport: Transport = urllib_transport,
        sleep: Callable[[float], None] = time.sleep,
        max_attempts: int = 3,
    ):
        self._token = access_token
        self._transport = transport
        self._sleep = sleep
        self._max_attempts = max_attempts

    def __repr__(self) -> str:  # never show the token in debug output
        return "LinkedInClient(<token redacted>)"

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self._token}",
            "LinkedIn-Version": config.LINKEDIN_VERSION,
            "X-Restli-Protocol-Version": "2.0.0",
            "Accept": "application/json",
        }
        headers.update(extra or {})
        return headers

    def get(self, path: str, query: str = "") -> dict:
        """GET an API path, retrying transient failures with exponential backoff."""
        url = f"{config.API_BASE}{path}" + (f"?{query}" if query else "")
        for attempt in range(1, self._max_attempts + 1):
            try:
                resp = self._transport("GET", url, self._headers(), None, TIMEOUT_SECONDS)
            except OSError as err:  # timeouts, DNS, connection resets
                if attempt == self._max_attempts:
                    raise ApiError(0, f"network error: {type(err).__name__}") from None
                self._sleep(2 ** (attempt - 1))
                continue
            if resp.status in RETRYABLE_STATUSES and attempt < self._max_attempts:
                self._sleep(self._retry_delay(resp, attempt))
                continue
            if not 200 <= resp.status < 300:
                raise ApiError(resp.status, describe_error(resp))
            return resp.json()
        raise AssertionError("unreachable")

    def post_json(self, path: str, payload: dict, query: str = "", restli_method: str | None = None) -> Response:
        """POST JSON once. Never retried: callers must treat UncertainResult as 'maybe created'."""
        url = f"{config.API_BASE}{path}" + (f"?{query}" if query else "")
        extra = {"Content-Type": "application/json"}
        if restli_method:
            extra["X-RestLi-Method"] = restli_method
        body = json.dumps(payload).encode()
        try:
            resp = self._transport("POST", url, self._headers(extra), body, TIMEOUT_SECONDS)
        except OSError as err:
            raise UncertainResult(f"POST {path} failed mid-request ({type(err).__name__})") from None
        if not 200 <= resp.status < 300:
            raise ApiError(resp.status, describe_error(resp))
        return resp

    def upload(self, upload_url: str, data: bytes, content_type: str) -> None:
        """Upload raw bytes to a URL returned by registerUpload."""
        if not is_linkedin_url(upload_url):
            # Never send the bearer token to a host we didn't expect.
            raise ApiError(0, "refusing to upload: registerUpload returned a non-linkedin.com URL")
        try:
            resp = self._transport(
                "POST", upload_url, self._headers({"Content-Type": content_type}), data, 120
            )
        except OSError as err:
            # Safe to rerun: an orphaned asset is harmless and nothing references it yet.
            raise ApiError(0, f"upload failed: {type(err).__name__}") from None
        if not 200 <= resp.status < 300:
            raise ApiError(resp.status, describe_error(resp))

    @staticmethod
    def _retry_delay(resp: Response, attempt: int) -> float:
        retry_after = resp.headers.get("retry-after", "")
        if retry_after.isdigit():
            return min(int(retry_after), 30)
        return 2 ** (attempt - 1)
