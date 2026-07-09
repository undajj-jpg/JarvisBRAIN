/**
 * Configuración vía variables de entorno (en Vercel: Project → Settings →
 * Environment Variables). Las estructuras complejas van como JSON.
 */

export interface EmailAccount {
  name: string;
  imapHost: string;
  imapPort?: number;
  smtpHost: string;
  smtpPort?: number;
  user: string;
  password: string;
}

export interface McpServerConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
  /** Patrones glob de tools que nunca se cargan (p. ej. "delete_*"). */
  blockedTools?: string[];
  /** Patrones glob de tools de escritura que exigen confirmación verbal. */
  confirmTools?: string[];
}

function parseJsonEnv<T>(name: string, fallback: T): T {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    console.error(`[config] La variable ${name} no es JSON válido; se ignora.`);
    return fallback;
  }
}

export function getEmailAccounts(): EmailAccount[] {
  return parseJsonEnv<EmailAccount[]>("EMAIL_ACCOUNTS", []);
}

export function getMcpServers(): McpServerConfig[] {
  return parseJsonEnv<McpServerConfig[]>("MCP_SERVERS", []);
}

export const AGENT_MODEL = process.env.JARVIS_MODEL || "claude-opus-4-8";
export const AGENT_EFFORT = (process.env.JARVIS_EFFORT || "low") as
  | "low"
  | "medium"
  | "high";
export const AGENT_MAX_TOKENS = Number(process.env.JARVIS_MAX_TOKENS || 16000);

/** Coincidencia glob simple ("create_*" → /^create_.*$/). */
export function globMatch(name: string, patterns: string[] | undefined): boolean {
  if (!patterns?.length) return false;
  return patterns.some((p) => {
    const re = new RegExp(
      "^" + p.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$"
    );
    return re.test(name);
  });
}
