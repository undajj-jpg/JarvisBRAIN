"""Herramientas de correo para Jarvis: leer IMAP, redactar y enviar (con
confirmación) por SMTP.

Las operaciones IMAP/SMTP son bloqueantes (stdlib), así que se ejecutan en
hilos con asyncio.to_thread para no congelar el pipeline de voz.
"""

from __future__ import annotations

import asyncio
import email
import imaplib
import smtplib
from email.header import decode_header, make_header
from email.message import EmailMessage
from email.utils import parseaddr

from anthropic import beta_async_tool

from ..config import EmailAccount
from ..notify import Notifier
from .outbox import Outbox

_MAX_BODY_CHARS = 4000


def _decode(value: str | None) -> str:
    if not value:
        return ""
    try:
        return str(make_header(decode_header(value)))
    except Exception:
        return value


def _extract_body(msg: email.message.Message) -> str:
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain" and not part.get(
                "Content-Disposition", ""
            ).startswith("attachment"):
                payload = part.get_payload(decode=True)
                if payload:
                    charset = part.get_content_charset() or "utf-8"
                    return payload.decode(charset, errors="replace")
        return "(sin cuerpo de texto plano)"
    payload = msg.get_payload(decode=True)
    if payload:
        charset = msg.get_content_charset() or "utf-8"
        return payload.decode(charset, errors="replace")
    return ""


class EmailService:
    def __init__(self, accounts: list[EmailAccount], outbox: Outbox, notifier: Notifier):
        self.accounts = {a.name: a for a in accounts}
        self.outbox = outbox
        self.notifier = notifier

    def _account(self, name: str) -> EmailAccount:
        if name not in self.accounts:
            known = ", ".join(self.accounts) or "(ninguna configurada)"
            raise ValueError(f"Cuenta '{name}' desconocida. Cuentas: {known}")
        return self.accounts[name]

    # ---- operaciones bloqueantes (se llaman vía to_thread) ----

    def _list_unread_sync(self, account: EmailAccount, limit: int) -> list[dict]:
        with imaplib.IMAP4_SSL(account.imap_host, account.imap_port) as imap:
            imap.login(account.user, account.password)
            imap.select("INBOX", readonly=True)
            _, data = imap.search(None, "UNSEEN")
            uids = data[0].split()[-limit:]
            out = []
            for uid in reversed(uids):
                _, msg_data = imap.fetch(uid, "(BODY.PEEK[HEADER])")
                msg = email.message_from_bytes(msg_data[0][1])
                out.append(
                    {
                        "uid": uid.decode(),
                        "from": _decode(msg.get("From")),
                        "subject": _decode(msg.get("Subject")),
                        "date": _decode(msg.get("Date")),
                    }
                )
            return out

    def _read_sync(self, account: EmailAccount, uid: str) -> dict:
        with imaplib.IMAP4_SSL(account.imap_host, account.imap_port) as imap:
            imap.login(account.user, account.password)
            imap.select("INBOX", readonly=True)
            _, msg_data = imap.fetch(uid.encode(), "(BODY.PEEK[])")
            if not msg_data or msg_data[0] is None:
                raise ValueError(f"No existe el correo con uid {uid}")
            msg = email.message_from_bytes(msg_data[0][1])
            return {
                "uid": uid,
                "from": _decode(msg.get("From")),
                "to": _decode(msg.get("To")),
                "subject": _decode(msg.get("Subject")),
                "date": _decode(msg.get("Date")),
                "message_id": msg.get("Message-ID", ""),
                "references": msg.get("References", ""),
                "body": _extract_body(msg)[:_MAX_BODY_CHARS],
            }

    def _send_sync(self, account: EmailAccount, draft) -> None:
        msg = EmailMessage()
        msg["From"] = account.user
        msg["To"] = draft.to
        msg["Subject"] = draft.subject
        if draft.in_reply_to:
            msg["In-Reply-To"] = draft.in_reply_to
            msg["References"] = (
                f"{draft.references} {draft.in_reply_to}".strip()
                if draft.references
                else draft.in_reply_to
            )
        msg.set_content(draft.body)

        if account.smtp_port == 465:
            with smtplib.SMTP_SSL(account.smtp_host, account.smtp_port) as smtp:
                smtp.login(account.user, account.password)
                smtp.send_message(msg)
        else:
            with smtplib.SMTP(account.smtp_host, account.smtp_port) as smtp:
                smtp.starttls()
                smtp.login(account.user, account.password)
                smtp.send_message(msg)


def build_email_tools(service: EmailService) -> list:
    """Crea las tools de correo con el servicio capturado en el closure."""

    @beta_async_tool
    async def list_unread_emails(account: str = "", limit: int = 10) -> str:
        """Lista los correos NO leídos de las cuentas de la empresa.

        Args:
            account: Nombre de la cuenta (p. ej. "ventas"). Vacío = todas.
            limit: Máximo de correos por cuenta (por defecto 10).
        """
        names = [account] if account else list(service.accounts)
        lines: list[str] = []
        for name in names:
            acc = service._account(name)
            try:
                msgs = await asyncio.to_thread(service._list_unread_sync, acc, limit)
            except Exception as exc:
                lines.append(f"[{name}] error al conectar: {exc}")
                continue
            if not msgs:
                lines.append(f"[{name}] sin correos nuevos.")
            for m in msgs:
                lines.append(
                    f"[{name}] uid={m['uid']} | de: {m['from']} | "
                    f"asunto: {m['subject']} | fecha: {m['date']}"
                )
        return "\n".join(lines) or "No hay cuentas configuradas."

    @beta_async_tool
    async def read_email(account: str, uid: str) -> str:
        """Lee el contenido completo de un correo concreto.

        Args:
            account: Nombre de la cuenta (p. ej. "ventas").
            uid: UID del correo, tal y como aparece en list_unread_emails.
        """
        acc = service._account(account)
        m = await asyncio.to_thread(service._read_sync, acc, uid)
        return (
            f"De: {m['from']}\nPara: {m['to']}\nAsunto: {m['subject']}\n"
            f"Fecha: {m['date']}\n\n{m['body']}"
        )

    @beta_async_tool
    async def draft_reply(account: str, uid: str, body: str, subject: str = "") -> str:
        """Redacta un BORRADOR de respuesta a un correo. NO lo envía: queda
        pendiente de que el usuario lo confirme con send_draft.

        Args:
            account: Cuenta desde la que se respondería.
            uid: UID del correo original al que se responde.
            body: Texto completo de la respuesta propuesta.
            subject: Asunto; vacío = "Re: <asunto original>".
        """
        acc = service._account(account)
        original = await asyncio.to_thread(service._read_sync, acc, uid)
        reply_to = parseaddr(original["from"])[1]
        subj = subject or (
            original["subject"]
            if original["subject"].lower().startswith("re:")
            else f"Re: {original['subject']}"
        )
        draft = service.outbox.create(
            account=account,
            to=reply_to,
            subject=subj,
            body=body,
            in_reply_to=original["message_id"],
            references=original["references"],
            original_uid=uid,
        )
        await service.notifier.notify(
            f"✉️ Borrador {draft.id} listo ({account} → {reply_to})",
            f"Asunto: {subj}\n\n{body}\n\nDi «envía el borrador {draft.id}» para mandarlo.",
        )
        return (
            f"Borrador creado con id {draft.id} (para {reply_to}, asunto: {subj}). "
            "Pendiente de confirmación del usuario. NO está enviado."
        )

    @beta_async_tool
    async def list_drafts() -> str:
        """Lista los borradores de correo pendientes de confirmación."""
        drafts = service.outbox.pending()
        if not drafts:
            return "No hay borradores pendientes."
        return "\n".join(
            f"id={d.id} | cuenta={d.account} | para={d.to} | asunto={d.subject}"
            for d in drafts
        )

    @beta_async_tool
    async def send_draft(draft_id: str) -> str:
        """Envía un borrador YA CONFIRMADO por el usuario. Llama a esta
        herramienta únicamente después de que el usuario haya dicho
        explícitamente que quiere enviarlo.

        Args:
            draft_id: Id del borrador (de draft_reply o list_drafts).
        """
        draft = service.outbox.get(draft_id)
        if draft is None:
            return f"No existe el borrador {draft_id}."
        if draft.status != "pending":
            return f"El borrador {draft_id} ya está en estado '{draft.status}'."
        acc = service._account(draft.account)
        await asyncio.to_thread(service._send_sync, acc, draft)
        service.outbox.mark(draft_id, "sent")
        await service.notifier.notify(
            f"✅ Enviado borrador {draft_id}", f"Para {draft.to} — {draft.subject}"
        )
        return f"Enviado a {draft.to} con asunto '{draft.subject}'."

    @beta_async_tool
    async def discard_draft(draft_id: str) -> str:
        """Descarta un borrador pendiente (el usuario no quiere enviarlo).

        Args:
            draft_id: Id del borrador a descartar.
        """
        draft = service.outbox.get(draft_id)
        if draft is None or draft.status != "pending":
            return f"No hay borrador pendiente con id {draft_id}."
        service.outbox.mark(draft_id, "discarded")
        return f"Borrador {draft_id} descartado."

    return [
        list_unread_emails,
        read_email,
        draft_reply,
        list_drafts,
        send_draft,
        discard_draft,
    ]
