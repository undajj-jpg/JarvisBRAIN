"""Notificaciones al usuario (consola siempre; Telegram opcional)."""

from __future__ import annotations

import httpx


class Notifier:
    def __init__(self, notifications_cfg: dict):
        tg = (notifications_cfg or {}).get("telegram") or {}
        self._tg_enabled = bool(tg.get("enabled")) and tg.get("bot_token")
        self._tg_token = tg.get("bot_token", "")
        self._tg_chat = tg.get("chat_id", "")

    async def notify(self, title: str, body: str) -> None:
        print(f"\n🔔 {title}\n{body}\n")
        if self._tg_enabled:
            try:
                async with httpx.AsyncClient(timeout=10) as http:
                    await http.post(
                        f"https://api.telegram.org/bot{self._tg_token}/sendMessage",
                        json={
                            "chat_id": self._tg_chat,
                            "text": f"{title}\n\n{body}",
                        },
                    )
            except Exception as exc:  # la notificación nunca debe romper el flujo
                print(f"[notify] Telegram falló: {exc}")
