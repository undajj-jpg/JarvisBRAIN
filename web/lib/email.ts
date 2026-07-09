/** Correo: lectura IMAP (imapflow) y envío SMTP (nodemailer). */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

import { EmailAccount, getEmailAccounts } from "./config";

const MAX_BODY_CHARS = 4000;

export function getAccount(name: string): EmailAccount {
  const accounts = getEmailAccounts();
  const acc = accounts.find((a) => a.name === name);
  if (!acc) {
    const known = accounts.map((a) => a.name).join(", ") || "(ninguna configurada)";
    throw new Error(`Cuenta '${name}' desconocida. Cuentas: ${known}`);
  }
  return acc;
}

async function withImap<T>(acc: EmailAccount, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: acc.imapHost,
    port: acc.imapPort ?? 993,
    secure: true,
    auth: { user: acc.user, pass: acc.password },
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

export interface EmailSummary {
  uid: string;
  from: string;
  subject: string;
  date: string;
}

export async function listUnread(accountName: string, limit = 10): Promise<EmailSummary[]> {
  const acc = getAccount(accountName);
  return withImap(acc, async (client) => {
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      const selected = (uids || []).slice(-limit).reverse();
      const out: EmailSummary[] = [];
      for (const uid of selected) {
        const msg = await client.fetchOne(String(uid), { envelope: true }, { uid: true });
        if (!msg || typeof msg === "boolean") continue;
        const env = msg.envelope;
        out.push({
          uid: String(uid),
          from: env?.from?.map((a) => `${a.name || ""} <${a.address || ""}>`).join(", ") || "",
          subject: env?.subject || "(sin asunto)",
          date: env?.date ? new Date(env.date).toISOString() : "",
        });
      }
      return out;
    } finally {
      lock.release();
    }
  });
}

export interface EmailFull {
  uid: string;
  from: string;
  fromAddress: string;
  to: string;
  subject: string;
  date: string;
  messageId: string;
  references: string;
  body: string;
}

export async function readEmail(accountName: string, uid: string): Promise<EmailFull> {
  const acc = getAccount(accountName);
  return withImap(acc, async (client) => {
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      const msg = await client.fetchOne(uid, { source: true }, { uid: true });
      if (!msg || typeof msg === "boolean" || !msg.source) {
        throw new Error(`No existe el correo con uid ${uid}`);
      }
      const parsed = await simpleParser(msg.source);
      return {
        uid,
        from: parsed.from?.text || "",
        fromAddress: parsed.from?.value?.[0]?.address || "",
        to: Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(", ") : parsed.to?.text || "",
        subject: parsed.subject || "(sin asunto)",
        date: parsed.date?.toISOString() || "",
        messageId: parsed.messageId || "",
        references: Array.isArray(parsed.references)
          ? parsed.references.join(" ")
          : parsed.references || "",
        body: (parsed.text || "(sin cuerpo de texto plano)").slice(0, MAX_BODY_CHARS),
      };
    } finally {
      lock.release();
    }
  });
}

export interface DraftEmail {
  account: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}

export async function sendEmail(draft: DraftEmail): Promise<string> {
  const acc = getAccount(draft.account);
  const port = acc.smtpPort ?? 587;
  const transporter = nodemailer.createTransport({
    host: acc.smtpHost,
    port,
    secure: port === 465,
    auth: { user: acc.user, pass: acc.password },
  });
  const info = await transporter.sendMail({
    from: acc.user,
    to: draft.to,
    subject: draft.subject,
    text: draft.body,
    inReplyTo: draft.inReplyTo || undefined,
    references: draft.references
      ? `${draft.references} ${draft.inReplyTo || ""}`.trim()
      : draft.inReplyTo || undefined,
  });
  return info.messageId || "enviado";
}
