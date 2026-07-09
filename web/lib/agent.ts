/**
 * Turno del agente en serverless: bucle manual con streaming.
 *
 * Serverless es stateless → el historial completo viaja con cada petición
 * (el cliente lo guarda y lo reenvía). Latencia:
 * - streaming de texto troceado en frases → el navegador va reproduciendo TTS
 * - prompt caching: system + tools estables entre turnos
 */

import Anthropic from "@anthropic-ai/sdk";

import { AGENT_EFFORT, AGENT_MAX_TOKENS, AGENT_MODEL } from "./config";
import { buildToolKit, EmitFn } from "./tools";

const SYSTEM_PROMPT = `Eres Jarvis, el asistente ejecutivo por voz de la empresa. El usuario te \
habla desde el navegador y tus respuestas se convierten a audio.

## Estilo (canal de voz)
- Español, natural y BREVE. Nada de markdown, viñetas ni emojis: todo se lee \
en voz alta. Di cifras y fechas de forma hablada.
- Si vas a consultar correo, ERP o CRM, avisa antes con una frase corta.

## Correo
- Puedes leer las cuentas de la empresa y proponer respuestas con \
propose_email. Esa herramienta solo muestra el borrador en pantalla: el \
envío lo decide el usuario con un botón, tú no puedes enviar nada.

## ERP, CRM y otros sistemas (herramientas MCP)
- Lecturas: hazlas directamente y resume.
- Escrituras: describe la operación, espera la confirmación verbal del \
usuario y solo entonces llama a la herramienta con _confirmed: true.

## Principios
- Si dudas de a qué cuenta, cliente o registro se refiere, pregunta.
- Nunca inventes datos: si una herramienta falla o no devuelve nada, dilo.`;

const SENTENCE_END = /([.!?…]+[\s\n]+|\n\n+)/g;
const MIN_CHUNK = 12;

function splitSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let start = 0;
  let m: RegExpExecArray | null;
  SENTENCE_END.lastIndex = 0;
  while ((m = SENTENCE_END.exec(buffer)) !== null) {
    const end = m.index + m[0].length;
    const chunk = buffer.slice(start, end);
    if (chunk.trim().length >= MIN_CHUNK || sentences.length > 0) {
      sentences.push(chunk);
      start = end;
    }
  }
  return { sentences, rest: buffer.slice(start) };
}

const client = new Anthropic();

/**
 * Ejecuta un turno completo (incluidas llamadas a herramientas) emitiendo
 * eventos SSE, y devuelve el historial actualizado para el cliente.
 */
export async function runAgentTurn(
  messages: Anthropic.Messages.MessageParam[],
  emit: EmitFn
): Promise<Anthropic.Messages.MessageParam[]> {
  const kit = await buildToolKit(emit);

  try {
    for (let iteration = 0; iteration < 12; iteration++) {
      const stream = client.messages.stream({
        model: AGENT_MODEL,
        max_tokens: AGENT_MAX_TOKENS,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        thinking: { type: "adaptive" },
        output_config: { effort: AGENT_EFFORT },
        tools: kit.tools,
        messages,
      });

      let buffer = "";
      stream.on("text", (delta) => {
        buffer += delta;
        const { sentences, rest } = splitSentences(buffer);
        buffer = rest;
        for (const s of sentences) emit({ type: "sentence", text: s });
      });

      const message = await stream.finalMessage();
      if (buffer.trim()) emit({ type: "sentence", text: buffer });

      messages.push({ role: "assistant", content: message.content });

      if (message.stop_reason === "pause_turn") continue;
      if (message.stop_reason !== "tool_use") break;

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const block of message.content) {
        if (block.type !== "tool_use") continue;
        emit({ type: "tool", name: block.name });
        const handler = kit.handlers.get(block.name);
        let result: string;
        let isError = false;
        if (!handler) {
          result = `Herramienta desconocida: ${block.name}`;
          isError = true;
        } else {
          try {
            result = await handler((block.input || {}) as Record<string, unknown>);
          } catch (e) {
            result = `Error: ${e instanceof Error ? e.message : String(e)}`;
            isError = true;
          }
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
          is_error: isError,
        });
      }
      messages.push({ role: "user", content: toolResults });
    }
  } finally {
    await kit.cleanup();
  }

  return messages;
}
