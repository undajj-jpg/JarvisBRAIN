"""Orquestador de voz de baja latencia.

Flujo por turno:
  micro → Deepgram (streaming) → frase final → agente Claude (streaming)
        → frases → ElevenLabs (streaming) → altavoz

Latencia: en ningún punto se espera a un resultado completo — todo son
streams encadenados. El usuario oye la primera frase de Jarvis mientras el
resto de la respuesta (y las llamadas a herramientas) siguen en marcha.

Barge-in: si el usuario habla mientras Jarvis está hablando, se corta la
reproducción y se cancela el turno en curso. Actívalo solo con auriculares
(con altavoces, el micro oiría a Jarvis y se interrumpiría a sí mismo).
"""

from __future__ import annotations

import asyncio

from ..agent import JarvisAgent
from .audio import Microphone, Speaker
from .stt_deepgram import DeepgramSTT
from .tts_elevenlabs import ElevenLabsTTS


async def run_voice(agent: JarvisAgent, cfg, barge_in: bool = False) -> None:
    stt_cfg = cfg.voice.stt or {}
    tts_cfg = cfg.voice.tts or {}
    sample_rate = int(stt_cfg.get("sample_rate", 16000))

    mic = Microphone(sample_rate=sample_rate)
    speaker = Speaker(sample_rate=int(tts_cfg.get("sample_rate", 16000)))
    stt = DeepgramSTT(stt_cfg)
    tts = ElevenLabsTTS(tts_cfg)

    mic.start()
    speaker.start()
    print("🎙️  Jarvis escuchando. Habla cuando quieras (Ctrl+C para salir).")

    current_turn: asyncio.Task | None = None
    pending = ""

    async def handle_turn(text: str) -> None:
        print(f"🧑 {text}")

        async def sentences():
            async for s in agent.ask(text):
                print(f"🤖 {s.strip()}")
                yield s

        try:
            await tts.speak(sentences(), speaker)
        except asyncio.CancelledError:
            speaker.interrupt()
            raise
        except Exception as exc:
            print(f"[voz] error en el turno: {exc}")

    try:
        async for tr in stt.transcripts(mic.queue):
            speaking = speaker.playing or (current_turn and not current_turn.done())

            if speaking and not barge_in:
                # Half-duplex: ignora lo que capte el micro mientras habla
                # Jarvis (evita que se escuche a sí mismo por los altavoces).
                continue

            if speaking and barge_in:
                # El usuario interrumpe: corta audio y cancela el turno.
                speaker.interrupt()
                if current_turn and not current_turn.done():
                    current_turn.cancel()

            if tr.speech_final:
                pending = f"{pending} {tr.text}".strip()
                if pending:
                    current_turn = asyncio.create_task(handle_turn(pending))
                    pending = ""
            elif tr.is_final:
                # Frase final parcial (pausa corta): acumula por si continúa.
                pending = f"{pending} {tr.text}".strip()
    finally:
        if current_turn and not current_turn.done():
            current_turn.cancel()
        mic.stop()
        speaker.stop()
