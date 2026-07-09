"""TTS en streaming con ElevenLabs (websocket stream-input).

Recibe frases según el agente las genera y va empujando audio PCM al altavoz
sin esperar a la respuesta completa — clave para la latencia percibida.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
from typing import AsyncIterator

import websockets

from .audio import Speaker


class ElevenLabsTTS:
    def __init__(self, cfg: dict):
        self.api_key = os.environ.get("ELEVENLABS_API_KEY", "")
        self.voice_id = os.environ.get("ELEVENLABS_VOICE_ID", "")
        self.model = cfg.get("model", "eleven_flash_v2_5")
        self.sample_rate = int(cfg.get("sample_rate", 16000))
        if not self.api_key or not self.voice_id:
            raise RuntimeError(
                "Faltan ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID en el entorno (.env)"
            )

    def _url(self) -> str:
        return (
            f"wss://api.elevenlabs.io/v1/text-to-speech/{self.voice_id}/stream-input"
            f"?model_id={self.model}&output_format=pcm_{self.sample_rate}"
        )

    async def speak(self, sentences: AsyncIterator[str], speaker: Speaker) -> None:
        """Convierte el stream de frases a audio y lo encola en el altavoz."""
        async with websockets.connect(self._url(), max_size=None) as ws:
            await ws.send(
                json.dumps(
                    {
                        "text": " ",
                        "voice_settings": {"stability": 0.5, "similarity_boost": 0.8},
                        "xi_api_key": self.api_key,
                    }
                )
            )

            async def _receiver() -> None:
                async for raw in ws:
                    msg = json.loads(raw)
                    if msg.get("audio"):
                        speaker.play(base64.b64decode(msg["audio"]))
                    if msg.get("isFinal"):
                        return

            receiver = asyncio.create_task(_receiver())
            try:
                async for sentence in sentences:
                    await ws.send(
                        json.dumps(
                            {"text": sentence.strip() + " ", "flush": True}
                        )
                    )
                await ws.send(json.dumps({"text": ""}))  # fin de entrada
                await receiver
            finally:
                if not receiver.done():
                    receiver.cancel()
