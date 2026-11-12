"""Process-local alerts for the single-process FastAPI deployment."""
from dataclasses import dataclass, field
import secrets
from threading import Lock
from time import monotonic

from pydantic import BaseModel


COOKIE = "marketplace_session"
LIFETIME = 1800


class Alert(BaseModel):
    item_id: str
    email: str
    target_minor: int


@dataclass
class Session:
    expires: float
    alerts: list[Alert] = field(default_factory=list)


class AlertStore:
    def __init__(self):
        self._sessions: dict[str, Session] = {}
        self._lock = Lock()

    def append(self, token: str | None, alert: Alert) -> tuple[str, bool]:
        with self._lock:
            now = monotonic()
            session = self._sessions.get(token)
            created = session is None or session.expires <= now
            if created:
                self._sessions = {key: value for key, value in self._sessions.items() if value.expires > now}
                token = secrets.token_urlsafe(32)
                session = self._sessions[token] = Session(now + LIFETIME)
            session.alerts.append(alert)
            return token, created

    def read(self, token: str | None) -> list[Alert]:
        with self._lock:
            session = self._sessions.get(token)
            if session is None:
                return []
            if session.expires <= monotonic():
                del self._sessions[token]
                return []
            return [alert.model_copy() for alert in session.alerts]


store = AlertStore()
