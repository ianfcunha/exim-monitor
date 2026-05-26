"""
Wrapper SSH para executar o script diag-exim.sh no servidor remoto.
Usa Paramiko com suporte a chave privada e senha.
"""
import json
import os
import re
from typing import Any, Dict, List, Optional

import paramiko

from .config import settings


class SSHError(Exception):
    """Erro de conexão SSH ou execução remota do script."""


def _get_client() -> paramiko.SSHClient:
    """Abre e retorna uma conexão SSH autenticada."""
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())

    kwargs: Dict[str, Any] = {
        "hostname": settings.ssh_host,
        "port": settings.ssh_port,
        "username": settings.ssh_user,
        "timeout": 15,
    }

    if settings.ssh_password:
        kwargs["password"] = settings.ssh_password
    else:
        key_path = os.path.expanduser(settings.ssh_key_path)
        kwargs["key_filename"] = key_path

    try:
        client.connect(**kwargs)
    except Exception as exc:
        raise SSHError(f"Não foi possível conectar a {settings.ssh_host}:{settings.ssh_port} — {exc}") from exc

    return client


def _run(args: str) -> Dict[str, Any]:
    """
    Executa o script com os argumentos fornecidos via SSH.
    Retorna o JSON parseado ou lança SSHError.
    """
    cmd = f"bash {settings.script_path} {args}"
    client = _get_client()
    try:
        _stdin, stdout, stderr = client.exec_command(cmd, timeout=90)
        output = stdout.read().decode("utf-8", errors="replace").strip()
        error = stderr.read().decode("utf-8", errors="replace").strip()
    finally:
        client.close()

    if not output:
        raise SSHError(
            f"Script não retornou saída."
            f"{(' stderr: ' + error[:300]) if error else ''}"
        )

    try:
        return json.loads(output)
    except json.JSONDecodeError as exc:
        raise SSHError(
            f"JSON inválido retornado pelo script: {exc}\n"
            f"Output (primeiros 500 chars): {output[:500]}"
        ) from exc


# ── API pública ────────────────────────────────────────────────────────

def run_quick() -> Dict[str, Any]:
    """Coleta leve (~1s) — usada pelo heartbeat do dashboard."""
    return _run("--quick")


def run_full() -> Dict[str, Any]:
    """Coleta completa — usada a cada 5 min e no botão de refresh."""
    return _run("--json")


def run_action(action: str, param: Optional[str] = None) -> Dict[str, Any]:
    """Executa uma ação isolada e retorna o JSON de resultado."""
    action_arg = f"{action}:{param}" if param else action
    return _run(f"--action={action_arg}")


# ── Mensagens: fila e log ──────────────────────────────────────────────

def _run_raw(cmd: str, timeout: int = 20) -> str:
    """Executa comando arbitrário via SSH e retorna stdout como string."""
    client = _get_client()
    try:
        _stdin, stdout, _stderr = client.exec_command(cmd, timeout=timeout)
        return stdout.read().decode("utf-8", errors="replace")
    finally:
        client.close()


def _parse_queue(raw: str) -> List[Dict[str, Any]]:
    """Converte saída de `exim -bp` em lista de dicts."""
    items: List[Dict[str, Any]] = []
    current: Optional[Dict[str, Any]] = None

    for line in raw.splitlines():
        stripped = line.strip()
        if not stripped:
            if current:
                items.append(current)
                current = None
            continue

        # Linha de cabeçalho da mensagem:
        # "  1m  3.4K 1tFN9b-000FqO-01 <sender@example.com>"
        m = re.match(
            r'^\s{0,4}(\S+)\s+(\S+)\s+([A-Za-z0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+)\s+(.*?)(\s+\*\*\* frozen \*\*\*)?$',
            line,
        )
        if m and not line.startswith(' ' * 12):
            if current:
                items.append(current)
            age, size, msg_id, sender_raw, frozen_marker = m.groups()
            sender = sender_raw.strip('<>').strip()
            current = {
                "message_id": msg_id,
                "age": age,
                "size": size,
                "sender": sender,
                "recipients": [],
                "frozen": bool(frozen_marker),
            }
        elif current and stripped and not stripped.startswith("***"):
            # Linha de destinatário (muito indentada)
            current["recipients"].append(stripped)

    if current:
        items.append(current)

    return items


_LOG_CANDIDATES = (
    "/var/log/exim4/mainlog",
    "/var/log/exim/mainlog",
    "/var/log/mail.log",
)

_LOG_GREP: Dict[str, str] = {
    "delivered": r" => ",
    "rejected":  r" \*\* ",
    "deferred":  r" == ",
    "sent":      r" <= ",
}


def _parse_log_line(line: str, msg_type: str) -> Optional[Dict[str, str]]:
    """Parse de uma linha do mainlog do EXIM."""
    # 2026-05-26 10:15:23 [pid] msg-id flag address ...
    m = re.match(
        r'^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})'
        r'(?:\s+\[\d+\])?'
        r'\s+([A-Za-z0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+)'
        r'\s+(\S+)'       # flag (=>, **, ==, <=)
        r'\s*(.*)',
        line.strip(),
    )
    if not m:
        return None

    ts, msg_id, flag, rest = m.groups()

    # Remetente F=<...>
    sender_m = re.search(r'F=<([^>]*)>', rest)
    sender = sender_m.group(1) if sender_m else ""

    # Endereço logo após o flag (primeiro token)
    first_token = rest.split()[0] if rest.split() else ""
    recipient = first_token.strip("<>") if "@" in first_token else ""

    # Detalhe: host de entrega ou motivo de rejeição
    detail = ""
    if msg_type == "delivered":
        h = re.search(r'H=(\S+)', rest)
        detail = h.group(1) if h else ""
    elif msg_type in ("rejected", "deferred"):
        # Tenta capturar mensagem após ":"
        d = re.search(r'(?:SMTP error[^:]*:|rejected after|temporarily rejected)[:\s]+(.+)', rest, re.I)
        if d:
            detail = d.group(1)[:100].strip()
        else:
            # Fallback: tudo depois do recipient
            parts = rest.split(None, 1)
            detail = (parts[1][:100] if len(parts) > 1 else rest[:100]).strip()
    elif msg_type == "sent":
        s = re.search(r'S=(\d+)', rest)
        detail = f"{int(s.group(1)) // 1024} KB" if s else ""

    return {
        "timestamp": ts,
        "message_id": msg_id,
        "sender": sender,
        "recipient": recipient,
        "detail": detail,
    }


def get_queue_items() -> List[Dict[str, Any]]:
    """Retorna itens da fila EXIM via `exim -bp`."""
    raw = _run_raw("exim -bp 2>/dev/null | head -1000")
    return _parse_queue(raw)


def get_log_entries(msg_type: str, limit: int = 200) -> List[Dict[str, str]]:
    """
    Retorna entradas do mainlog filtradas por tipo.

    msg_type: 'delivered' | 'rejected' | 'deferred' | 'sent'
    limit:    número máximo de linhas retornadas (mais recentes)
    """
    pattern = _LOG_GREP.get(msg_type)
    if not pattern:
        return []

    # Tenta cada path de log em ordem
    candidates = " ".join(f'"{p}"' for p in _LOG_CANDIDATES)
    cmd = (
        f"for f in {candidates}; do "
        f'  [ -f "$f" ] && grep -E \'{pattern}\' "$f" 2>/dev/null | tail -{limit} && break; '
        f"done"
    )
    raw = _run_raw(cmd)

    entries = []
    for line in raw.splitlines():
        parsed = _parse_log_line(line, msg_type)
        if parsed:
            entries.append(parsed)

    # Mais recentes primeiro
    return list(reversed(entries))
