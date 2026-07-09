"""Núcleo del agente: Claude + tool runner con streaming.

Diseño para latencia mínima:
- Streaming de texto: los deltas se trocean en frases y se van entregando al
  TTS sin esperar a que termine la respuesta completa.
- Prompt caching: system prompt y lista de tools estables → tras el primer
  turno, el prefijo se sirve desde caché (~10x más barato y más rápido).
- El texto intermedio entre llamadas a herramientas ("voy a mirarlo...")
  también se habla, así el usuario nunca espera en silencio.
"""

from __future__ import annotations

import inspect
import re
from typing import AsyncIterator

from anthropic import AsyncAnthropic

from .prompts import build_system

# Corta en finales de frase razonables para ir alimentando el TTS.
_SENTENCE_END = re.compile(r"([.!?…]+[\s\n]+|\n\n+|:\s*\n)")
# No hables trozos demasiado cortos (evita "Sí." → latencia de red por nada).
_MIN_CHUNK = 12


def _split_sentences(buffer: str) -> tuple[list[str], str]:
    """Devuelve (frases completas, resto pendiente)."""
    sentences: list[str] = []
    start = 0
    for m in _SENTENCE_END.finditer(buffer):
        chunk = buffer[start : m.end()]
        if len(chunk.strip()) >= _MIN_CHUNK or sentences:
            sentences.append(chunk)
            start = m.end()
    return sentences, buffer[start:]


class JarvisAgent:
    def __init__(self, client: AsyncAnthropic, cfg, tools: list):
        self.client = client
        self.cfg = cfg
        self.tools = tools
        self.system = build_system(cfg.agent.language)
        self.history: list[dict] = []

    async def ask(self, user_text: str) -> AsyncIterator[str]:
        """Procesa un turno del usuario y va cediendo frases de la respuesta.

        Maneja internamente el bucle agéntico completo (llamadas a correo,
        ERP, CRM...). Cada frase cedida puede mandarse directa al TTS.
        """
        self.history.append({"role": "user", "content": user_text})

        runner = self.client.beta.messages.tool_runner(
            model=self.cfg.agent.model,
            max_tokens=self.cfg.agent.max_tokens,
            system=self.system,
            thinking={"type": "adaptive"},
            output_config={"effort": self.cfg.agent.effort},
            tools=self.tools,
            messages=self.history,
            stream=True,
        )

        async for stream in runner:
            buffer = ""
            async for event in stream:
                if (
                    event.type == "content_block_delta"
                    and event.delta.type == "text_delta"
                ):
                    buffer += event.delta.text
                    sentences, buffer = _split_sentences(buffer)
                    for s in sentences:
                        yield s
            if buffer.strip():
                yield buffer

            # Refleja el historial para mantener contexto multi-turno,
            # incluyendo los bloques tool_use / tool_result.
            final = await stream.get_final_message()
            self.history.append({"role": "assistant", "content": final.content})
            tool_response = runner.generate_tool_call_response()
            if inspect.isawaitable(tool_response):
                tool_response = await tool_response
            if tool_response is not None:
                self.history.append(dict(tool_response))

    def reset(self) -> None:
        self.history.clear()
