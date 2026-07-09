"use client";

/**
 * Interfaz de Jarvis: chat por voz (mantener pulsado el micro) o texto.
 * - El audio se graba en el navegador → /api/stt → texto.
 * - /api/chat devuelve la respuesta por SSE frase a frase; cada frase se
 *   convierte a voz con /api/tts y se reproduce en cola (latencia mínima).
 * - Los borradores de correo aparecen como tarjeta con Enviar/Descartar:
 *   el envío SOLO ocurre si el humano pulsa el botón.
 */

import { useCallback, useEffect, useRef, useState } from "react";

interface Draft {
  account: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}

interface ChatItem {
  id: number;
  role: "user" | "jarvis" | "info";
  text?: string;
  draft?: Draft;
  draftStatus?: "pending" | "sending" | "sent" | "discarded" | "error";
}

let nextId = 1;

export default function Home() {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);

  const historyRef = useRef<unknown[]>([]);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // --- cola de reproducción de audio (frase a frase) ---
  const audioQueueRef = useRef<Blob[]>([]);
  const playingRef = useRef(false);
  const voiceOnRef = useRef(true);
  useEffect(() => {
    voiceOnRef.current = voiceOn;
  }, [voiceOn]);

  const playNext = useCallback(() => {
    const blob = audioQueueRef.current.shift();
    if (!blob) {
      playingRef.current = false;
      return;
    }
    playingRef.current = true;
    const audio = new Audio(URL.createObjectURL(blob));
    audio.onended = () => {
      URL.revokeObjectURL(audio.src);
      playNext();
    };
    audio.onerror = () => playNext();
    audio.play().catch(() => playNext());
  }, []);

  const speak = useCallback(
    async (text: string) => {
      if (!voiceOnRef.current) return;
      try {
        const resp = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!resp.ok) return;
        const blob = await resp.blob();
        audioQueueRef.current.push(blob);
        if (!playingRef.current) playNext();
      } catch {
        /* sin voz configurada: seguimos solo con texto */
      }
    },
    [playNext]
  );

  const add = useCallback((item: Omit<ChatItem, "id">) => {
    const id = nextId++;
    setItems((prev) => [...prev, { ...item, id }]);
    return id;
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [items]);

  // --- turno de conversación ---
  const sendText = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean || busy) return;
      setBusy(true);
      add({ role: "user", text: clean });

      let jarvisId: number | null = null;
      const appendJarvis = (chunk: string) => {
        if (jarvisId === null) {
          jarvisId = add({ role: "jarvis", text: chunk });
        } else {
          setItems((prev) =>
            prev.map((it) => (it.id === jarvisId ? { ...it, text: (it.text || "") + chunk } : it))
          );
        }
      };

      try {
        const resp = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: historyRef.current, text: clean }),
        });
        if (!resp.ok || !resp.body) {
          add({ role: "info", text: `Error del servidor (${resp.status}).` });
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            if (!raw.startsWith("data: ")) continue;
            const event = JSON.parse(raw.slice(6));
            if (event.type === "sentence") {
              appendJarvis(event.text);
              void speak(event.text);
            } else if (event.type === "tool") {
              add({ role: "info", text: `⚙️ ${event.name}` });
              jarvisId = null; // la siguiente frase abre burbuja nueva
            } else if (event.type === "draft") {
              add({ role: "info", draft: event.draft, draftStatus: "pending", text: "" });
              jarvisId = null;
            } else if (event.type === "done") {
              historyRef.current = event.messages;
            } else if (event.type === "error") {
              add({ role: "info", text: `❌ ${event.message}` });
            }
          }
        }
      } catch (e) {
        add({ role: "info", text: `❌ ${e instanceof Error ? e.message : e}` });
      } finally {
        setBusy(false);
      }
    },
    [add, busy, speak]
  );

  // --- micrófono (mantener pulsado) ---
  const startRecording = useCallback(async () => {
    if (busy || recording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        if (blob.size < 2000) return; // pulsación accidental
        const resp = await fetch("/api/stt", {
          method: "POST",
          headers: { "Content-Type": "audio/webm" },
          body: blob,
        });
        const data = await resp.json();
        if (data.text) void sendText(data.text);
        else add({ role: "info", text: "No te he entendido, prueba otra vez." });
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      add({ role: "info", text: "No hay acceso al micrófono." });
    }
  }, [add, busy, recording, sendText]);

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  }, []);

  // --- borradores ---
  const actOnDraft = useCallback(async (item: ChatItem, action: "send" | "discard") => {
    if (!item.draft) return;
    if (action === "discard") {
      setItems((prev) =>
        prev.map((it) => (it.id === item.id ? { ...it, draftStatus: "discarded" } : it))
      );
      return;
    }
    setItems((prev) => prev.map((it) => (it.id === item.id ? { ...it, draftStatus: "sending" } : it)));
    try {
      const resp = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item.draft),
      });
      const ok = resp.ok;
      setItems((prev) =>
        prev.map((it) => (it.id === item.id ? { ...it, draftStatus: ok ? "sent" : "error" } : it))
      );
    } catch {
      setItems((prev) =>
        prev.map((it) => (it.id === item.id ? { ...it, draftStatus: "error" } : it))
      );
    }
  }, []);

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <span style={{ fontSize: 22 }}>🧠 Jarvis</span>
        <button
          style={{ ...styles.pill, opacity: voiceOn ? 1 : 0.5 }}
          onClick={() => setVoiceOn((v) => !v)}
          title="Activar/desactivar la voz de Jarvis"
        >
          {voiceOn ? "🔊 Voz" : "🔇 Voz"}
        </button>
      </header>

      <div ref={scrollRef} style={styles.chat}>
        {items.length === 0 && (
          <p style={styles.hint}>
            Mantén pulsado el micrófono y habla, o escribe abajo.
            <br />
            Prueba: «¿Hay correos nuevos?»
          </p>
        )}
        {items.map((it) => {
          if (it.draft) {
            return (
              <div key={it.id} style={styles.draftCard}>
                <div style={styles.draftHeader}>✉️ Borrador — {it.draft.account} → {it.draft.to}</div>
                <div style={styles.draftSubject}>{it.draft.subject}</div>
                <pre style={styles.draftBody}>{it.draft.body}</pre>
                {it.draftStatus === "pending" && (
                  <div style={{ display: "flex", gap: 8 }}>
                    <button style={styles.sendBtn} onClick={() => actOnDraft(it, "send")}>
                      Enviar
                    </button>
                    <button style={styles.discardBtn} onClick={() => actOnDraft(it, "discard")}>
                      Descartar
                    </button>
                  </div>
                )}
                {it.draftStatus === "sending" && <em>Enviando…</em>}
                {it.draftStatus === "sent" && <em style={{ color: "#7ee787" }}>✅ Enviado</em>}
                {it.draftStatus === "discarded" && <em style={{ opacity: 0.6 }}>Descartado</em>}
                {it.draftStatus === "error" && <em style={{ color: "#ff7b72" }}>Error al enviar</em>}
              </div>
            );
          }
          const style =
            it.role === "user"
              ? styles.userBubble
              : it.role === "jarvis"
                ? styles.jarvisBubble
                : styles.infoLine;
          return (
            <div key={it.id} style={style}>
              {it.text}
            </div>
          );
        })}
        {busy && <div style={styles.infoLine}>Jarvis está pensando…</div>}
      </div>

      <footer style={styles.footer}>
        <button
          style={{
            ...styles.micBtn,
            background: recording ? "#e5484d" : "#1f6feb",
          }}
          onPointerDown={startRecording}
          onPointerUp={stopRecording}
          onPointerLeave={() => recording && stopRecording()}
          disabled={busy}
        >
          {recording ? "● Escuchando… (suelta para enviar)" : "🎙️ Mantén pulsado para hablar"}
        </button>
        <form
          style={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            const t = input;
            setInput("");
            void sendText(t);
          }}
        >
          <input
            style={styles.input}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="…o escribe aquí"
            disabled={busy}
          />
          <button style={styles.sendBtn} disabled={busy || !input.trim()}>
            Enviar
          </button>
        </form>
      </footer>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: { display: "flex", flexDirection: "column", height: "100dvh", maxWidth: 760, margin: "0 auto" },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "14px 16px",
    borderBottom: "1px solid #21262d",
  },
  pill: { background: "#21262d", color: "#e6e9ef", borderRadius: 999, padding: "6px 14px" },
  chat: { flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 10 },
  hint: { opacity: 0.6, textAlign: "center", marginTop: 48, lineHeight: 1.7 },
  userBubble: {
    alignSelf: "flex-end",
    background: "#1f6feb",
    borderRadius: "16px 16px 4px 16px",
    padding: "10px 14px",
    maxWidth: "85%",
    whiteSpace: "pre-wrap",
  },
  jarvisBubble: {
    alignSelf: "flex-start",
    background: "#161b22",
    border: "1px solid #21262d",
    borderRadius: "16px 16px 16px 4px",
    padding: "10px 14px",
    maxWidth: "85%",
    whiteSpace: "pre-wrap",
  },
  infoLine: { alignSelf: "center", opacity: 0.55, fontSize: 13 },
  draftCard: {
    alignSelf: "stretch",
    background: "#161b22",
    border: "1px solid #30363d",
    borderRadius: 12,
    padding: 14,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  draftHeader: { fontSize: 13, opacity: 0.8 },
  draftSubject: { fontWeight: 600 },
  draftBody: {
    whiteSpace: "pre-wrap",
    fontFamily: "inherit",
    background: "#0b0e14",
    borderRadius: 8,
    padding: 10,
    maxHeight: 220,
    overflowY: "auto",
  },
  footer: { padding: 12, borderTop: "1px solid #21262d", display: "flex", flexDirection: "column", gap: 8 },
  micBtn: {
    color: "white",
    borderRadius: 12,
    padding: "14px 16px",
    fontSize: 16,
    userSelect: "none",
    touchAction: "none",
  },
  form: { display: "flex", gap: 8 },
  input: {
    flex: 1,
    background: "#161b22",
    border: "1px solid #21262d",
    borderRadius: 10,
    padding: "10px 12px",
    color: "#e6e9ef",
    outline: "none",
  },
  sendBtn: { background: "#238636", color: "white", borderRadius: 10, padding: "10px 16px" },
  discardBtn: { background: "#21262d", color: "#e6e9ef", borderRadius: 10, padding: "10px 16px" },
};
