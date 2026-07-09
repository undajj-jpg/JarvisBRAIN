/**
 * POST /api/chat — un turno del agente, respuesta por SSE.
 * Body: { messages: MessageParam[] (historial previo), text: string (turno del usuario) }
 * Eventos: {type:'sentence'|'tool'|'draft'|'done'|'error', ...}
 */

import Anthropic from "@anthropic-ai/sdk";
import { NextRequest } from "next/server";

import { runAgentTurn } from "@/lib/agent";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const { messages = [], text } = (await req.json()) as {
    messages?: Anthropic.Messages.MessageParam[];
    text: string;
  };

  if (!text?.trim()) {
    return Response.json({ error: "Falta 'text'" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      try {
        const history = [...messages, { role: "user" as const, content: text }];
        const updated = await runAgentTurn(history, emit);
        emit({ type: "done", messages: updated });
      } catch (e) {
        emit({ type: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
