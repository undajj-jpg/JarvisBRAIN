"""E/S de audio local: micrófono y altavoz (PCM16 mono) con sounddevice."""

from __future__ import annotations

import asyncio

import sounddevice as sd


class Microphone:
    """Captura del micro → asyncio.Queue de bytes PCM16."""

    def __init__(self, sample_rate: int = 16000, block_ms: int = 20):
        self.sample_rate = sample_rate
        self.blocksize = int(sample_rate * block_ms / 1000)
        self.queue: asyncio.Queue[bytes] = asyncio.Queue()
        self._stream: sd.RawInputStream | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    def _callback(self, indata, frames, time_info, status) -> None:
        if self._loop is not None:
            self._loop.call_soon_threadsafe(self.queue.put_nowait, bytes(indata))

    def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        self._stream = sd.RawInputStream(
            samplerate=self.sample_rate,
            blocksize=self.blocksize,
            channels=1,
            dtype="int16",
            callback=self._callback,
        )
        self._stream.start()

    def stop(self) -> None:
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None


class Speaker:
    """Reproduce PCM16 desde una cola; interrumpible (barge-in)."""

    def __init__(self, sample_rate: int = 16000):
        self.sample_rate = sample_rate
        self.queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        self.playing = False
        self._task: asyncio.Task | None = None
        self._stream: sd.RawOutputStream | None = None

    def start(self) -> None:
        self._stream = sd.RawOutputStream(
            samplerate=self.sample_rate, channels=1, dtype="int16"
        )
        self._stream.start()
        self._task = asyncio.create_task(self._player())

    async def _player(self) -> None:
        while True:
            chunk = await self.queue.get()
            if chunk is None:
                continue
            self.playing = True
            try:
                await asyncio.to_thread(self._stream.write, chunk)
            except Exception:
                pass
            if self.queue.empty():
                self.playing = False

    def play(self, pcm: bytes) -> None:
        self.queue.put_nowait(pcm)

    def interrupt(self) -> None:
        """Vacía todo lo pendiente (el usuario ha interrumpido a Jarvis)."""
        while not self.queue.empty():
            try:
                self.queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        self.playing = False

    def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
