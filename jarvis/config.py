"""Carga de configuración: config/jarvis.yaml + variables de entorno (.env)."""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv

_ENV_PATTERN = re.compile(r"\$\{([A-Z0-9_]+)\}")


def _expand_env(value: Any) -> Any:
    if isinstance(value, str):
        return _ENV_PATTERN.sub(lambda m: os.environ.get(m.group(1), ""), value)
    if isinstance(value, dict):
        return {k: _expand_env(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_expand_env(v) for v in value]
    return value


@dataclass
class AgentConfig:
    model: str = "claude-opus-4-8"
    effort: str = "low"
    max_tokens: int = 16000
    language: str = "es"


@dataclass
class EmailAccount:
    name: str
    imap_host: str
    smtp_host: str
    user: str
    password: str
    imap_port: int = 993
    smtp_port: int = 587


@dataclass
class McpServerConfig:
    name: str
    transport: str = "http"  # "http" | "stdio"
    url: str = ""
    headers: dict[str, str] = field(default_factory=dict)
    command: str = ""
    args: list[str] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    blocked_tools: list[str] = field(default_factory=list)
    confirm_tools: list[str] = field(default_factory=list)


@dataclass
class VoiceConfig:
    stt: dict[str, Any] = field(default_factory=dict)
    tts: dict[str, Any] = field(default_factory=dict)


@dataclass
class JarvisConfig:
    agent: AgentConfig
    voice: VoiceConfig
    email_accounts: list[EmailAccount]
    mcp_servers: list[McpServerConfig]
    notifications: dict[str, Any]
    data_dir: Path


def load_config(path: str | None = None) -> JarvisConfig:
    load_dotenv()

    root = Path(__file__).resolve().parent.parent
    cfg_path = Path(path) if path else root / "config" / "jarvis.yaml"
    if not cfg_path.exists():
        example = root / "config" / "jarvis.example.yaml"
        raise FileNotFoundError(
            f"No existe {cfg_path}. Copia {example} a config/jarvis.yaml y ajústalo."
        )

    raw = _expand_env(yaml.safe_load(cfg_path.read_text()) or {})

    agent = AgentConfig(**(raw.get("agent") or {}))
    voice = VoiceConfig(**(raw.get("voice") or {}))
    accounts = [EmailAccount(**a) for a in (raw.get("email_accounts") or [])]
    servers = [McpServerConfig(**s) for s in (raw.get("mcp_servers") or [])]

    data_dir = root / "data"
    data_dir.mkdir(exist_ok=True)

    return JarvisConfig(
        agent=agent,
        voice=voice,
        email_accounts=accounts,
        mcp_servers=servers,
        notifications=raw.get("notifications") or {},
        data_dir=data_dir,
    )
