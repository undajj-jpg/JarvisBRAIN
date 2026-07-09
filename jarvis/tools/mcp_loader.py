"""Conexión a servidores MCP (ERP, CRM, etc.) y conversión de sus
herramientas a tools de Claude.

Seguridad:
- blocked_tools: esas herramientas ni siquiera se registran (bloqueo duro).
- confirm_tools: gate en dos fases. La primera llamada NO ejecuta nada;
  devuelve al modelo la instrucción de pedir confirmación verbal al usuario.
  Solo una segunda llamada con los mismos argumentos (dentro de 5 minutos)
  ejecuta la operación real.
"""

from __future__ import annotations

import fnmatch
import json
import time
from contextlib import AsyncExitStack

from anthropic.lib.tools.mcp import async_mcp_tool
from mcp import ClientSession, StdioServerParameters
from mcp import types as mcp_types
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamablehttp_client

from ..config import McpServerConfig

_CONFIRM_TTL_SECONDS = 300


def _matches(name: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(name, p) for p in patterns)


def _text_result(text: str, is_error: bool = False) -> mcp_types.CallToolResult:
    return mcp_types.CallToolResult(
        content=[mcp_types.TextContent(type="text", text=text)],
        isError=is_error,
    )


class _GatedSession:
    """Proxy sobre ClientSession que aplica el gate de confirmación."""

    def __init__(self, session: ClientSession, cfg: McpServerConfig):
        self._session = session
        self._cfg = cfg
        self._armed: dict[str, float] = {}

    def __getattr__(self, item):
        return getattr(self._session, item)

    async def call_tool(self, name: str, arguments=None, **kwargs):
        if _matches(name, self._cfg.blocked_tools):
            return _text_result(
                f"La herramienta '{name}' está bloqueada por política de la "
                "empresa y no puede ejecutarse.",
                is_error=True,
            )
        if _matches(name, self._cfg.confirm_tools):
            key = f"{name}:{json.dumps(arguments, sort_keys=True, default=str)}"
            now = time.monotonic()
            armed_at = self._armed.get(key)
            if armed_at is None or now - armed_at > _CONFIRM_TTL_SECONDS:
                self._armed[key] = now
                return _text_result(
                    "CONFIRMACIÓN REQUERIDA: esta operación modifica datos en "
                    f"'{self._cfg.name}'. Describe al usuario exactamente qué "
                    "vas a hacer y espera a que confirme verbalmente. Si "
                    "confirma, vuelve a llamar a esta herramienta con los "
                    "mismos argumentos. Si no confirma, no la llames."
                )
            del self._armed[key]
        return await self._session.call_tool(name, arguments=arguments, **kwargs)


class McpManager:
    """Mantiene vivas las conexiones MCP durante toda la sesión de Jarvis."""

    def __init__(self, servers: list[McpServerConfig]):
        self._configs = servers
        self._stack = AsyncExitStack()

    async def start(self) -> list:
        """Conecta a todos los servidores y devuelve las tools para el agente."""
        tools: list = []
        for cfg in self._configs:
            try:
                session = await self._connect(cfg)
            except Exception as exc:
                print(f"[mcp] ⚠️  No se pudo conectar a '{cfg.name}': {exc}")
                continue
            gated = _GatedSession(session, cfg)
            listed = await session.list_tools()
            count = 0
            for tool in listed.tools:
                if _matches(tool.name, cfg.blocked_tools):
                    continue
                tools.append(async_mcp_tool(tool, gated))
                count += 1
            print(f"[mcp] ✓ '{cfg.name}': {count} herramientas cargadas.")
        return tools

    async def _connect(self, cfg: McpServerConfig) -> ClientSession:
        if cfg.transport == "stdio":
            params = StdioServerParameters(
                command=cfg.command, args=cfg.args, env=cfg.env or None
            )
            read, write = await self._stack.enter_async_context(stdio_client(params))
        else:
            read, write, _ = await self._stack.enter_async_context(
                streamablehttp_client(cfg.url, headers=cfg.headers or None)
            )
        session = await self._stack.enter_async_context(ClientSession(read, write))
        await session.initialize()
        return session

    async def stop(self) -> None:
        await self._stack.aclose()
