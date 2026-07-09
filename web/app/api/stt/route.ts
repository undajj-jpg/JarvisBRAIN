/**
 * POST /api/stt — transcribe un clip de audio del navegador con Deepgram.
 * Body: audio binario (webm/opus del MediaRecorder). Respuesta: { text }.
 */

import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) {
    return Response.json({ error: "Falta DEEPGRAM_API_KEY" }, { status: 500 });
  }

  const audio = await req.arrayBuffer();
  if (!audio.byteLength) {
    return Response.json({ error: "Audio vacío" }, { status: 400 });
  }

  const params = new URLSearchParams({
    model: process.env.DEEPGRAM_MODEL || "nova-2",
    language: process.env.JARVIS_LANGUAGE || "es",
    smart_format: "true",
  });

  const resp = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${key}`,
      "Content-Type": req.headers.get("content-type") || "audio/webm",
    },
    body: audio,
  });

  if (!resp.ok) {
    const detail = await resp.text();
    return Response.json({ error: `Deepgram ${resp.status}: ${detail}` }, { status: 502 });
  }

  const data = await resp.json();
  const text: string =
    data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
  return Response.json({ text });
}
