/**
 * POST /api/send — envía un borrador de correo.
 *
 * Este endpoint SOLO lo invoca la interfaz cuando el humano pulsa «Enviar»
 * en la tarjeta del borrador. El modelo no tiene ninguna herramienta que
 * llegue aquí: es la barrera estructural de confirmación.
 */

import { NextRequest } from "next/server";

import { DraftEmail, sendEmail } from "@/lib/email";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const draft = (await req.json()) as DraftEmail;
  if (!draft?.account || !draft?.to || !draft?.body) {
    return Response.json({ error: "Borrador incompleto" }, { status: 400 });
  }
  try {
    const id = await sendEmail(draft);
    return Response.json({ ok: true, id });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}
