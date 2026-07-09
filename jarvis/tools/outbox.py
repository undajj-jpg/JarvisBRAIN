"""Bandeja de salida con confirmación humana.

Jarvis nunca envía correo directamente: draft_reply deja el borrador aquí,
se notifica al usuario, y solo send_draft(id) —tras confirmación verbal—
ejecuta el envío por SMTP.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass
class Draft:
    id: str
    account: str
    to: str
    subject: str
    body: str
    in_reply_to: str = ""
    references: str = ""
    status: str = "pending"  # pending | sent | discarded
    original_uid: str = ""
    extra: dict = field(default_factory=dict)


class Outbox:
    def __init__(self, data_dir: Path):
        self._path = data_dir / "outbox.json"
        self._drafts: dict[str, Draft] = {}
        self._load()

    def _load(self) -> None:
        if self._path.exists():
            for d in json.loads(self._path.read_text() or "[]"):
                self._drafts[d["id"]] = Draft(**d)

    def _save(self) -> None:
        self._path.write_text(
            json.dumps([asdict(d) for d in self._drafts.values()], indent=2, ensure_ascii=False)
        )

    def create(self, **kwargs) -> Draft:
        draft = Draft(id=uuid.uuid4().hex[:8], **kwargs)
        self._drafts[draft.id] = draft
        self._save()
        return draft

    def get(self, draft_id: str) -> Draft | None:
        return self._drafts.get(draft_id)

    def pending(self) -> list[Draft]:
        return [d for d in self._drafts.values() if d.status == "pending"]

    def mark(self, draft_id: str, status: str) -> None:
        if draft_id in self._drafts:
            self._drafts[draft_id].status = status
            self._save()
