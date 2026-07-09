# Jarvis Web — despliegue en Vercel

Versión web de Jarvis: el micrófono se captura en el navegador y el agente
corre en funciones serverless. Accesible desde cualquier dispositivo (móvil
incluido) sin instalar nada.

## Desplegar en Vercel (5 minutos)

1. Entra en [vercel.com/new](https://vercel.com/new) e **importa este
   repositorio** (`undajj-jpg/JarvisBRAIN`).
2. En la pantalla de configuración del proyecto:
   - **Root Directory**: `web`  ← imprescindible (el repo también contiene la
     versión de escritorio en Python).
   - Framework: Next.js (lo detecta solo).
3. Añade las **Environment Variables** (copia los valores de `.env.example`):
   - `ANTHROPIC_API_KEY` (obligatoria)
   - `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` (voz)
   - `EMAIL_ACCOUNTS` (JSON con las cuentas IMAP/SMTP)
   - `MCP_SERVERS` (JSON con tu ERP/CRM vía MCP)
4. **Deploy**. Listo: abre la URL en el móvil o el portátil y habla con Jarvis.

También puedes desplegar por CLI:

```bash
cd web && npx vercel --prod
```

> Nota: los turnos con muchas herramientas pueden tardar; las funciones están
> configuradas con `maxDuration = 60`. En el plan Hobby de Vercel el límite es
> 60 s (suficiente); en Pro puedes subirlo.

## Cómo funciona

```
navegador ──(audio webm)──► /api/stt ──► Deepgram
navegador ◄──(SSE frases)── /api/chat ──► Claude + tools (correo, MCP)
navegador ──(cada frase)──► /api/tts ──► ElevenLabs ──► audio en cola
humano ─────(botón Enviar)► /api/send ──► SMTP
```

- **Mantén pulsado el micro** para hablar; al soltar se transcribe y responde.
- Las respuestas llegan **frase a frase** por SSE y se reproducen en cola: oyes
  la primera frase mientras el resto aún se genera.
- **El modelo no puede enviar correos**: la herramienta `propose_email` solo
  pinta una tarjeta con el borrador; el envío ocurre únicamente cuando TÚ
  pulsas «Enviar» (barrera estructural, no de prompt).
- ERP/CRM (MCP): lecturas directas; escrituras con confirmación en la
  conversación (`confirmTools`) o bloqueadas del todo (`blockedTools`).
- Serverless es stateless: el historial de conversación vive en tu navegador
  y viaja con cada petición.

## Desarrollo local

```bash
cd web
cp .env.example .env.local   # rellena tus claves
npm install
npm run dev                  # http://localhost:3000
```
