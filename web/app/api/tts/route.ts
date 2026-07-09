/**
 * POST /api/tts — convierte una frase a audio (ElevenLabs, streaming).
 * Body: { text }. Respuesta: audio/mpeg en streaming.
 */

import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const key = process.env.ELEVENLABS_API_KEY;
  const voice = process.env.ELEVENLABS_VOICE_ID;
  if (!key || !voice) {
    return Response.json(
      { error: "Faltan ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID" },
      { status: 500 }
    );
  }

  const { text } = (await req.json()) as { text: string };
  if (!text?.trim()) {
    return Response.json({ error: "Falta 'text'" }, { status: 400 });
  }

  const resp = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?output_format=mp3_22050_32`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
        voice_settings: { stability: 0.5, similarity_boost: 0.8 },
      }),
    }
  );

  if (!resp.ok || !resp.body) {
    const detail = await resp.text();
    return Response.json({ error: `ElevenLabs ${resp.status}: ${detail}` }, { status: 502 });
  }

  return new Response(resp.body, {
    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" },
  });
}
