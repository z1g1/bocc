"""Local record of events this tool has tried to create, keyed by event date.

LinkedIn may not list or return an event until it has been posted, so the API
can't reliably tell us whether we already created this week's event. This
ledger can. An entry is written as `pending` *before* the create request and
upgraded to `created` after it, so a crash or timeout mid-request blocks
further attempts until a human checks LinkedIn and runs `bocc-event forget`.
After the publishing post succeeds the entry becomes `posted`, so `bocc-event
post` can retry a failed post without ever posting twice.
"""

import json
import os
import tempfile
from datetime import date, datetime
from pathlib import Path

PENDING = "pending"  # create request sent, outcome unknown
CREATED = "created"  # event exists but isn't posted yet (invisible on LinkedIn)
POSTED = "posted"  # event published by the admin's post


def default_path(env=os.environ) -> Path:
    if env.get("LINKEDIN_LEDGER_FILE"):
        return Path(env["LINKEDIN_LEDGER_FILE"]).expanduser()
    base = Path(env.get("XDG_STATE_HOME") or Path.home() / ".local" / "state")
    return base / "bocc-linkedin" / "ledger.json"


class Ledger:
    def __init__(self, path: Path):
        self.path = path

    def _read(self) -> dict:
        if not self.path.exists():
            return {}
        return json.loads(self.path.read_text()).get("events", {})

    def _write(self, events: dict) -> None:
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=".ledger-")
        try:
            with os.fdopen(fd, "w") as fh:
                json.dump({"events": events}, fh, indent=2, sort_keys=True)
            os.replace(tmp, self.path)
        except BaseException:
            os.unlink(tmp)
            raise

    def get(self, day: date) -> dict | None:
        return self._read().get(day.isoformat())

    def record_pending(self, day: date, name: str, now: datetime) -> None:
        events = self._read()
        events[day.isoformat()] = {"status": PENDING, "name": name, "attempted_at": now.isoformat()}
        self._write(events)

    def record_created(self, day: date, event_id: str, url: str, now: datetime) -> None:
        events = self._read()
        entry = events.get(day.isoformat(), {})
        entry.update({"status": CREATED, "event_id": event_id, "url": url, "created_at": now.isoformat()})
        events[day.isoformat()] = entry
        self._write(events)

    def record_posted(self, day: date, post_urn: str, now: datetime) -> None:
        events = self._read()
        entry = events.get(day.isoformat(), {})
        entry.update({"status": POSTED, "post_urn": post_urn, "posted_at": now.isoformat()})
        events[day.isoformat()] = entry
        self._write(events)

    def forget(self, day: date) -> bool:
        events = self._read()
        removed = events.pop(day.isoformat(), None) is not None
        if removed:
            self._write(events)
        return removed
