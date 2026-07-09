"""STT en streaming con Deepgram (websocket).

Envía el audio del micro en tiempo real y emite eventos de transcripción:
parciales (para detectar barge-in) y finales de frase (speech_final) que son
los que disparan el turno del agente.
"""

from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from typing import AsyncIterator
from urllib.parse import urlencode

import websockets


@dataclass
class Transcript:
    text: str
    is_final: bool
    speech_final: bool


class DeepgramSTT:
    def __init__(self, cfg: dict):
        self.api_key = os.environ.get("DEEPGRAM_API_KEY", "")
        self.model = cfg.get("model", "nova-2")
        self.language = cfg.get("language", "es")
        self.sample_rate = int(cfg.get("sample_rate", 16000))
        self.endpointing_ms = int(cfg.get("endpointing_ms", 300))
        if not self.api_key:
            raise RuntimeError("Falta DEEPGRAM_API_KEY en el entorno (.env)")

    def _url(self) -> str:
        params = urlencode(
            {
                "model": self.model,
                "language": self.language,
                "encoding": "linear16",
                "sample_rate": self.sample_rate,
                "channels": 1,
                "interim_results": "true",
                "smart_format": "true",
                "endpointing": self.endpointing_ms,
            }
        )
        return f"wss://api.deepgram.com/v1/listen?{params}"

    async def transcripts(
        self, audio_queue: asyncio.Queue[bytes]
    ) -> AsyncIterator[Transcript]:
        """Conecta al WS, bombea audio y va cediendo transcripciones."""
        headers = {"Authorization": f"Token {self.api_key}"}
        async with websockets.connect(
            self._url(), additional_headers=headers, max_size=None
        ) as ws:

            async def _sender() -> None:
                while True:
                    chunk = await audio_queue.get()
                    await ws.send(chunk)

            sender = asyncio.create_task(_sender())
            try:
                async for raw in ws:
                    msg = json.loads(raw)
                    if msg.get("type") != "Results":
                        continue
                    alt = msg["channel"]["alternatives"][0]
                    text = alt.get("transcript", "").strip()
                    if not text:
                        continue
                    yield Transcript(
                        text=text,
                        is_final=bool(msg.get("is_final")),
                        speech_final=bool(msg.get("speech_final")),
                    )
            finally:
                sender.cancel()
