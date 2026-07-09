"""Punto de entrada de Jarvis.

  python -m jarvis            → modo voz (necesita claves de Deepgram/ElevenLabs)
  python -m jarvis --text     → modo texto (REPL, solo necesita ANTHROPIC_API_KEY)
  python -m jarvis --barge-in → modo voz con interrupción (usar con auriculares)
"""

from __future__ import annotations

import argparse
import asyncio

from anthropic import AsyncAnthropic

from .agent import JarvisAgent
from .config import load_config
from .notify import Notifier
from .tools.email_tools import EmailService, build_email_tools
from .tools.mcp_loader import McpManager
from .tools.outbox import Outbox


async def text_repl(agent: JarvisAgent) -> None:
    print("💬 Modo texto. Escribe y pulsa Enter ('salir' para terminar).\n")
    loop = asyncio.get_running_loop()
    while True:
        try:
            user = (await loop.run_in_executor(None, input, "🧑 > ")).strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not user:
            continue
        if user.lower() in {"salir", "exit", "quit"}:
            break
        print("🤖 ", end="", flush=True)
        async for sentence in agent.ask(user):
            print(sentence, end="", flush=True)
        print()


async def amain(args: argparse.Namespace) -> None:
    cfg = load_config(args.config)

    notifier = Notifier(cfg.notifications)
    outbox = Outbox(cfg.data_dir)
    email_service = EmailService(cfg.email_accounts, outbox, notifier)

    tools: list = build_email_tools(email_service)

    mcp = McpManager(cfg.mcp_servers)
    tools += await mcp.start()
    print(f"[jarvis] {len(tools)} herramientas disponibles.")

    client = AsyncAnthropic()
    agent = JarvisAgent(client, cfg, tools)

    try:
        if args.text:
            await text_repl(agent)
        else:
            from .voice.pipeline import run_voice

            await run_voice(agent, cfg, barge_in=args.barge_in)
    finally:
        await mcp.stop()


def main() -> None:
    parser = argparse.ArgumentParser(prog="jarvis")
    parser.add_argument("--text", action="store_true", help="REPL de texto (sin voz)")
    parser.add_argument(
        "--barge-in",
        action="store_true",
        help="Permite interrumpir a Jarvis hablando (recomendado con auriculares)",
    )
    parser.add_argument("--config", default=None, help="Ruta a jarvis.yaml")
    args = parser.parse_args()
    try:
        asyncio.run(amain(args))
    except KeyboardInterrupt:
        print("\n👋 Hasta luego.")


if __name__ == "__main__":
    main()
