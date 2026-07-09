/**
 * Herramientas del agente para la versión web.
 *
 * Diferencia clave con la versión de escritorio: aquí el ENVÍO de correo no
 * es una herramienta del modelo. propose_email solo presenta un borrador en
 * la interfaz; el envío real ocurre cuando el humano pulsa «Enviar» (que
 * llama a /api/send). El modelo no puede enviar correo bajo ningún concepto.
 *
 * Los servidores MCP (ERP/CRM) se conectan por petición (serverless es
 * stateless). blocked_tools se filtran en duro; confirm_tools reciben un
 * parámetro extra `_confirmed` que el modelo solo debe activar tras el "sí"
 * del usuario (gate a nivel de prompt en esta versión).
 */

import Anthropic from "@anthropic-ai/sdk";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { getEmailAccounts, getMcpServers, globMatch } from "./config";
import { DraftEmail, listUnread, readEmail } from "./email";

export type EmitFn = (event: Record<string, unknown>) => void;
export type ToolHandler = (input: Record<string, unknown>) => Promise<string>;

export interface ToolKit {
  tools: Anthropic.Messages.ToolUnion[];
  handlers: Map<string, ToolHandler>;
  cleanup: () => Promise<void>;
}

function emailTools(emit: EmitFn): {
  tools: Anthropic.Messages.Tool[];
  handlers: Map<string, ToolHandler>;
} {
  const handlers = new Map<string, ToolHandler>();
  const accountNames = getEmailAccounts().map((a) => a.name);

  const tools: Anthropic.Messages.Tool[] = [
    {
      name: "list_unread_emails",
      description:
        "Lista los correos NO leídos de las cuentas de correo de la empresa. " +
        `Cuentas disponibles: ${accountNames.join(", ") || "(ninguna)"}.`,
      input_schema: {
        type: "object",
        properties: {
          account: {
            type: "string",
            description: "Nombre de la cuenta. Vacío = todas las cuentas.",
          },
          limit: { type: "integer", description: "Máximo por cuenta (por defecto 10)." },
        },
        required: [],
      },
    },
    {
      name: "read_email",
      description: "Lee el contenido completo de un correo concreto.",
      input_schema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Nombre de la cuenta." },
          uid: { type: "string", description: "UID del correo (de list_unread_emails)." },
        },
        required: ["account", "uid"],
      },
    },
    {
      name: "propose_email",
      description:
        "Presenta al usuario un BORRADOR de correo en la interfaz para que él " +
        "decida si lo envía. Esta herramienta NO envía nada: el envío solo " +
        "puede hacerlo el usuario pulsando el botón «Enviar» del borrador. " +
        "Úsala para responder a un correo (pasa reply_to_uid) o para un correo nuevo.",
      input_schema: {
        type: "object",
        properties: {
          account: { type: "string", description: "Cuenta desde la que se enviaría." },
          to: { type: "string", description: "Destinatario. Si respondes a un correo, déjalo vacío y usa reply_to_uid." },
          subject: { type: "string", description: "Asunto del correo." },
          body: { type: "string", description: "Cuerpo completo del correo propuesto." },
          reply_to_uid: {
            type: "string",
            description: "UID del correo original si es una respuesta (rellena destinatario, hilo y Re: automáticamente).",
          },
        },
        required: ["account", "body"],
      },
    },
  ];

  handlers.set("list_unread_emails", async (input) => {
    const names = input.account ? [String(input.account)] : accountNames;
    const limit = Number(input.limit || 10);
    const lines: string[] = [];
    for (const name of names) {
      try {
        const msgs = await listUnread(name, limit);
        if (!msgs.length) lines.push(`[${name}] sin correos nuevos.`);
        for (const m of msgs) {
          lines.push(`[${name}] uid=${m.uid} | de: ${m.from} | asunto: ${m.subject} | fecha: ${m.date}`);
        }
      } catch (e) {
        lines.push(`[${name}] error al conectar: ${e instanceof Error ? e.message : e}`);
      }
    }
    return lines.join("\n") || "No hay cuentas de correo configuradas.";
  });

  handlers.set("read_email", async (input) => {
    const m = await readEmail(String(input.account), String(input.uid));
    return `De: ${m.from}\nPara: ${m.to}\nAsunto: ${m.subject}\nFecha: ${m.date}\n\n${m.body}`;
  });

  handlers.set("propose_email", async (input) => {
    const account = String(input.account);
    let to = String(input.to || "");
    let subject = String(input.subject || "");
    let inReplyTo = "";
    let references = "";
    if (input.reply_to_uid) {
      const original = await readEmail(account, String(input.reply_to_uid));
      to = to || original.fromAddress;
      subject = subject || (original.subject.toLowerCase().startsWith("re:") ? original.subject : `Re: ${original.subject}`);
      inReplyTo = original.messageId;
      references = original.references;
    }
    if (!to) return "Falta el destinatario: indica 'to' o 'reply_to_uid'.";
    const draft: DraftEmail = { account, to, subject, body: String(input.body), inReplyTo, references };
    emit({ type: "draft", draft });
    return (
      `Borrador presentado al usuario en pantalla (para ${to}, asunto: ${subject}). ` +
      "NO está enviado: el usuario decidirá con los botones Enviar/Descartar. " +
      "Dile brevemente que tiene el borrador en pantalla."
    );
  });

  return { tools, handlers };
}

interface McpConnection {
  client: McpClient;
}

async function mcpTools(): Promise<{
  tools: Anthropic.Messages.Tool[];
  handlers: Map<string, ToolHandler>;
  connections: McpConnection[];
}> {
  const tools: Anthropic.Messages.Tool[] = [];
  const handlers = new Map<string, ToolHandler>();
  const connections: McpConnection[] = [];

  for (const server of getMcpServers()) {
    try {
      const transport = new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: server.headers },
      });
      const client = new McpClient({ name: "jarvis-web", version: "0.1.0" });
      await client.connect(transport);
      connections.push({ client });

      const listed = await client.listTools();
      for (const tool of listed.tools) {
        if (globMatch(tool.name, server.blockedTools)) continue;

        const needsConfirm = globMatch(tool.name, server.confirmTools);
        const qualified = `${server.name}__${tool.name}`;
        const schema = JSON.parse(JSON.stringify(tool.inputSchema || { type: "object", properties: {} }));
        if (needsConfirm) {
          schema.properties = schema.properties || {};
          schema.properties._confirmed = {
            type: "boolean",
            description:
              "OBLIGATORIO poner a true SOLO si el usuario ya confirmó verbalmente esta operación exacta. Sin confirmación, llama sin este campo.",
          };
        }

        tools.push({
          name: qualified,
          description: `[${server.name}] ${tool.description || tool.name}`,
          input_schema: schema,
        });

        handlers.set(qualified, async (input) => {
          const args = { ...input };
          if (needsConfirm) {
            const confirmed = args._confirmed === true;
            delete args._confirmed;
            if (!confirmed) {
              return (
                `CONFIRMACIÓN REQUERIDA: esta operación modifica datos en '${server.name}'. ` +
                "Describe al usuario exactamente qué vas a hacer y espera su confirmación. " +
                "Solo si confirma, vuelve a llamar con _confirmed: true."
              );
            }
          }
          const result = await client.callTool({ name: tool.name, arguments: args });
          const content = Array.isArray(result.content) ? result.content : [];
          const text = content
            .map((c: { type?: string; text?: string }) => (c.type === "text" ? c.text || "" : `[${c.type}]`))
            .join("\n");
          return result.isError ? `ERROR de la herramienta: ${text}` : text || "(sin salida)";
        });
      }
    } catch (e) {
      console.error(`[mcp] No se pudo conectar a '${server.name}':`, e);
    }
  }

  return { tools, handlers, connections };
}

export async function buildToolKit(emit: EmitFn): Promise<ToolKit> {
  const email = emailTools(emit);
  const mcp = await mcpTools();

  const handlers = new Map<string, ToolHandler>([...email.handlers, ...mcp.handlers]);
  const tools: Anthropic.Messages.ToolUnion[] = [...email.tools, ...mcp.tools];

  return {
    tools,
    handlers,
    cleanup: async () => {
      await Promise.allSettled(mcp.connections.map((c) => c.client.close()));
    },
  };
}
