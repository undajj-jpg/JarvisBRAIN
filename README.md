# JarvisBRAIN 🧠🎙️

Asistente de voz de **baja latencia** para tu empresa, construido sobre Claude.
Le hablas, te responde en voz, y tiene acceso real a los sistemas de la empresa:

- **Correo**: revisa las cuentas de la empresa, resume lo importante y **redacta
  respuestas que tú confirmas antes de enviar** (nunca envía nada solo).
- **ERP**: conectado vía MCP — pregúntale datos o pídele que registre cosas.
- **CRM**: igual, vía MCP — clientes, oportunidades, notas...
- **Cualquier otro sistema** que exponga un servidor MCP: se añade en el YAML
  de configuración y sus herramientas aparecen automáticamente.

## ¿Por qué tiene tan poca latencia?

Todo el pipeline es **streaming de punta a punta** — nunca se espera a un
resultado completo:

```
 micro ──► Deepgram STT ──► Claude (agente) ──► ElevenLabs TTS ──► altavoz
        (websocket,        (streaming +        (websocket,
         parciales en       prompt caching)     frase a frase)
         tiempo real)
```

1. **STT en streaming**: Deepgram transcribe mientras hablas; el fin de frase
   se detecta por *endpointing* (~300 ms de silencio), no por un botón.
2. **Respuesta troceada en frases**: en cuanto Claude genera la primera frase,
   ya está sonando por el altavoz mientras el resto se sigue generando.
3. **Prompt caching**: el system prompt y la lista de herramientas son
   estables, así que a partir del primer turno el prefijo se sirve de caché
   (arranque del modelo mucho más rápido y ~10x más barato).
4. **Habla mientras trabaja**: cuando consulta correo/ERP/CRM, Jarvis avisa
   ("voy a mirarlo") y ese aviso se reproduce mientras las herramientas corren.
5. **Effort configurable**: por defecto `low` para respuestas ágiles de voz;
   súbelo para tareas de análisis pesado.
6. **Barge-in opcional**: con `--barge-in` puedes interrumpirle hablando
   (recomendado solo con auriculares para que no se oiga a sí mismo).

## Puesta en marcha

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env                          # rellena tus claves
cp config/jarvis.example.yaml config/jarvis.yaml   # ajusta cuentas y MCP
```

Claves necesarias:

| Clave | Para qué | ¿Obligatoria? |
|---|---|---|
| `ANTHROPIC_API_KEY` | El cerebro (Claude) | Sí |
| `DEEPGRAM_API_KEY` | Voz → texto | Solo modo voz |
| `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` | Texto → voz | Solo modo voz |
| Contraseñas IMAP/SMTP | Correo | Para las tools de correo |
| Tokens de tus MCP | ERP / CRM | Para esos sistemas |

### Probar sin voz (solo necesitas la clave de Anthropic)

```bash
python -m jarvis --text
```

### Modo voz

```bash
python -m jarvis              # half-duplex (altavoces OK)
python -m jarvis --barge-in   # puedes interrumpirle (usa auriculares)
```

## Flujo de correo con confirmación

1. «Jarvis, ¿hay correos nuevos en ventas?» → lista y resume los no leídos.
2. «Respóndele que la semana que viene le mando presupuesto» → crea un
   **borrador** (id corto, p. ej. `a3f9c1d2`), te lo lee y te **notifica**
   (consola y, si lo activas, Telegram).
3. «Envíalo» / «envía el borrador a3f9c1d2» → solo entonces sale por SMTP.
4. «Descártalo» → se elimina sin enviar.

Los borradores persisten en `data/outbox.json`, así que puedes confirmarlos
más tarde.

## ERP, CRM y otros sistemas (MCP)

Cada servidor MCP se declara en `config/jarvis.yaml`. Soporta transporte
`http` (streamable HTTP, con headers de autenticación) y `stdio` (comando
local). Dos niveles de protección por servidor:

- `blocked_tools`: patrones de herramientas que **nunca** se cargan
  (p. ej. `delete_*`).
- `confirm_tools`: herramientas de escritura que requieren **confirmación
  verbal en dos fases** — la primera llamada no ejecuta nada, solo obliga a
  Jarvis a describirte la operación y esperar tu «sí»; la segunda llamada
  (mismos argumentos, dentro de 5 min) ejecuta de verdad.

## Estructura del proyecto

```
jarvis/
  agent.py            # núcleo Claude: tool runner, streaming, caching
  prompts.py          # system prompt (estable → cacheable)
  config.py           # YAML + .env
  notify.py           # notificaciones (consola / Telegram)
  tools/
    email_tools.py    # IMAP/SMTP + flujo borrador→confirmación→envío
    outbox.py         # persistencia de borradores
    mcp_loader.py     # conexión a ERP/CRM/etc. + gates de seguridad
  voice/
    audio.py          # micro y altavoz (sounddevice)
    stt_deepgram.py   # voz → texto en streaming
    tts_elevenlabs.py # texto → voz en streaming
    pipeline.py       # orquestador del turno de voz + barge-in
```

## Ideas siguientes (roadmap)

- **Calendario** (Google Calendar / Outlook vía MCP): «¿qué tengo mañana?»,
  «búscame un hueco con Marta el jueves».
- **Briefing matinal**: al decir «buenos días», resumen de correos nuevos,
  agenda del día y alertas del ERP (pedidos pendientes, cobros vencidos).
- **Memoria persistente**: que recuerde preferencias y contexto entre
  sesiones (fichero de notas que el agente lee/escribe).
- **Notificaciones proactivas**: un proceso en segundo plano que vigile las
  bandejas de entrada y te avise por Telegram de correos urgentes con la
  respuesta ya redactada, lista para confirmar.
- **Wake word** («oye Jarvis») con openWakeWord para dejarlo siempre
  escuchando sin gastar STT.
- **Multiusuario / web**: exponer el pipeline por WebRTC para usarlo desde el
  móvil o el navegador.
