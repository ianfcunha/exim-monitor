"""
Wrapper SSH para executar o script diag-exim.sh no servidor remoto.

Todas as funções públicas aceitam um parâmetro opcional `server_cfg` (dict).
Quando omitido, usam as configurações do .env (retrocompatibilidade).

server_cfg = {
    "host":                str,
    "port":                int,
    "ssh_user":            str,
    "ssh_auth_type":       "password" | "key",
    "ssh_secret":          str,   # senha ou conteúdo da chave privada (já decriptografado)
    "script_path":         str,
    "host_key_fingerprint": str | None,  # fingerprint conhecido (pinning) — None = primeira conexão
}
"""
import base64
import hashlib
import io
import json
import os
import re
import time
from typing import Any, Dict, List, Optional

import paramiko

from .config import settings


class SSHError(Exception):
    """Erro de conexão SSH ou execução remota do script."""


class HostKeyMismatchError(SSHError):
    """
    A chave do host mudou desde o fingerprint conhecido (pinned).
    Pode indicar um ataque MITM ou que o servidor foi reinstalado —
    exige confirmação manual antes de prosseguir.
    """


def _fingerprint(key: paramiko.PKey) -> str:
    """Fingerprint SHA256 no mesmo formato do `ssh-keygen -lf` (OpenSSH)."""
    digest = hashlib.sha256(key.asbytes()).digest()
    return "SHA256:" + base64.b64encode(digest).decode().rstrip("=")


class _PinnedHostKeyPolicy(paramiko.MissingHostKeyPolicy):
    """
    Substitui AutoAddPolicy (que aceita qualquer chave sem verificar — brecha
    de MITM). Como o SSHClient aqui nunca carrega known_hosts, toda conexão
    passa por missing_host_key(), o que a torna o ponto certo para pinning
    contra o fingerprint salvo no cadastro do servidor.

    expected_fingerprint=None: primeira conexão — aceita e expõe o
    fingerprint observado em `self.observed_fingerprint` para o chamador
    decidir se persiste (confirmação explícita no fluxo de cadastro/teste).

    expected_fingerprint=<str>: só aceita se bater; caso contrário rejeita
    levantando HostKeyMismatchError.
    """

    def __init__(self, expected_fingerprint: Optional[str] = None):
        self.expected_fingerprint = expected_fingerprint
        self.observed_fingerprint: Optional[str] = None

    def missing_host_key(self, client, hostname, key):
        self.observed_fingerprint = _fingerprint(key)
        if self.expected_fingerprint and self.observed_fingerprint != self.expected_fingerprint:
            raise HostKeyMismatchError(
                f"A chave do host {hostname} não bate com o fingerprint "
                f"conhecido (esperado {self.expected_fingerprint}, recebido "
                f"{self.observed_fingerprint}). Pode ser um ataque MITM ou o "
                f"servidor foi reinstalado — confirme manualmente antes de "
                f"continuar."
            )
        # Primeira conexão (expected_fingerprint=None) ou fingerprint bate: aceita.


def _default_cfg() -> Dict[str, Any]:
    """Configuração SSH a partir do .env (retrocompatibilidade)."""
    return {
        "host":                settings.ssh_host,
        "port":                settings.ssh_port,
        "ssh_user":            settings.ssh_user,
        "ssh_auth_type":       "key" if not settings.ssh_password else "password",
        "ssh_secret":          settings.ssh_password or "",
        "script_path":         settings.script_path,
        "host_key_fingerprint": None,
    }


def _get_client(server_cfg: Optional[Dict[str, Any]] = None) -> paramiko.SSHClient:
    """Abre e retorna uma conexão SSH autenticada.

    Verifica a chave do host contra `cfg["host_key_fingerprint"]` (pinning).
    O fingerprint observado nesta conexão fica em
    `client.observed_host_key_fingerprint` para quem chamou decidir se
    persiste (ex.: primeira conexão de um servidor recém-cadastrado).
    """
    cfg = server_cfg or _default_cfg()

    client = paramiko.SSHClient()
    policy = _PinnedHostKeyPolicy(cfg.get("host_key_fingerprint"))
    client.set_missing_host_key_policy(policy)

    kwargs: Dict[str, Any] = {
        "hostname": cfg["host"],
        "port":     cfg["port"],
        "username": cfg["ssh_user"],
        "timeout":  15,
    }

    auth_type  = cfg.get("ssh_auth_type", "password")
    ssh_secret = cfg.get("ssh_secret", "")

    if auth_type == "key" and ssh_secret:
        # ssh_secret contém o conteúdo da chave privada
        try:
            pkey = paramiko.RSAKey.from_private_key(io.StringIO(ssh_secret))
            kwargs["pkey"] = pkey
        except Exception:
            try:
                pkey = paramiko.Ed25519Key.from_private_key(io.StringIO(ssh_secret))
                kwargs["pkey"] = pkey
            except Exception as exc:
                raise SSHError(f"Não foi possível carregar a chave privada: {exc}") from exc
    elif auth_type == "key" and not ssh_secret:
        # Fallback: tenta chave do .env
        key_path = os.path.expanduser(settings.ssh_key_path)
        kwargs["key_filename"] = key_path
    else:
        kwargs["password"] = ssh_secret

    try:
        client.connect(**kwargs)
    except HostKeyMismatchError:
        raise
    except Exception as exc:
        raise SSHError(
            f"Não foi possível conectar a {cfg['host']}:{cfg['port']} — {exc}"
        ) from exc

    client.observed_host_key_fingerprint = policy.observed_fingerprint
    return client


def _run(args: str, server_cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Executa o script com os argumentos fornecidos via SSH."""
    cfg = server_cfg or _default_cfg()
    cmd = f"bash {cfg['script_path']} {args}"
    client = _get_client(cfg)
    try:
        _stdin, stdout, stderr = client.exec_command(cmd, timeout=90)
        try:
            output = stdout.read().decode("utf-8", errors="replace").strip()
            error  = stderr.read().decode("utf-8", errors="replace").strip()
        except TimeoutError as exc:
            raise SSHError(
                f"Comando '{args}' não respondeu em 90s no servidor remoto "
                f"({cfg['host']}) — script pode estar desatualizado, travado "
                f"ou esse argumento não é suportado pela versão instalada lá."
            ) from exc
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


def _run_raw(cmd: str, timeout: int = 20,
             server_cfg: Optional[Dict[str, Any]] = None) -> str:
    """Executa comando arbitrário via SSH e retorna stdout como string."""
    client = _get_client(server_cfg)
    try:
        _stdin, stdout, _stderr = client.exec_command(cmd, timeout=timeout)
        try:
            return stdout.read().decode("utf-8", errors="replace")
        except TimeoutError as exc:
            raise SSHError(f"Comando não respondeu em {timeout}s no servidor remoto.") from exc
    finally:
        client.close()


# ── Teste de conexão ───────────────────────────────────────────────────────

def test_connection(server_cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Abre e fecha uma conexão SSH de teste.
    Retorna {"latency_ms": int, "fingerprint": str} — fingerprint é o
    observado nesta conexão (pode ou não já ser o conhecido/pinned).
    Lança SSHError (ou HostKeyMismatchError) em caso de falha.
    """
    t0 = time.monotonic()
    client = _get_client(server_cfg)
    fingerprint = getattr(client, "observed_host_key_fingerprint", None)
    client.close()
    latency_ms = int((time.monotonic() - t0) * 1000)
    return {"latency_ms": latency_ms, "fingerprint": fingerprint}


# ── API pública ────────────────────────────────────────────────────────────

def run_quick(server_cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Coleta leve (~1s) — usada pelo heartbeat do dashboard."""
    return _run("--quick", server_cfg)


def run_full(server_cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Coleta completa — usada a cada 5 min e no botão de refresh."""
    return _run("--json", server_cfg)


_UNSAFE_ACTOR_CHARS = re.compile(r"[^A-Za-z0-9._@-]+")


def _sanitize_actor(actor: str) -> str:
    """
    Reduz o actor a um conjunto seguro de caracteres antes de interpolar
    no comando shell remoto. Username vem de campo livre (pode ser um
    e-mail, por exemplo) — nunca confiamos nele para montar comando.
    """
    cleaned = _UNSAFE_ACTOR_CHARS.sub("", actor).strip("-")
    return cleaned[:64]


def run_action(action: str, param: Optional[str] = None,
               server_cfg: Optional[Dict[str, Any]] = None,
               actor: Optional[str] = None) -> Dict[str, Any]:
    """Executa uma ação isolada e retorna o JSON de resultado."""
    action_arg = f"{action}:{param}" if param else action
    args = f"--action={action_arg}"
    if actor:
        safe_actor = _sanitize_actor(actor)
        if safe_actor:
            args += f" --actor={safe_actor}"
    return _run(args, server_cfg)


def run_check(server_cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Autodiagnóstico do servidor remoto (pré-requisitos): binário exim,
    exiqgrep, espaço em disco, mainlog acessível, cPanel/WHM, CSF.
    Usado no cadastro/teste de servidor para validar que o script está
    presente e funcional — não só que a porta SSH responde.
    """
    return _run("--check", server_cfg)


# ── Mensagens: fila e log ──────────────────────────────────────────────────

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
                "age":        age,
                "size":       size,
                "sender":     sender,
                "recipients": [],
                "frozen":     bool(frozen_marker),
            }
        elif current and stripped and not stripped.startswith("***"):
            current["recipients"].append(stripped)

    if current:
        items.append(current)

    return items


_LOG_CANDIDATES = (
    "/var/log/exim4/mainlog",
    "/var/log/exim/mainlog",
    "/var/log/exim_mainlog",
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
    m = re.match(
        r'^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})'
        r'(?:\s+\[\d+\])?'
        r'\s+([A-Za-z0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+)'
        r'\s+(\S+)'
        r'\s*(.*)',
        line.strip(),
    )
    if not m:
        return None

    ts, msg_id, flag, rest = m.groups()

    sender_m = re.search(r'F=<([^>]*)>', rest)
    sender   = sender_m.group(1) if sender_m else ""

    first_token = rest.split()[0] if rest.split() else ""
    recipient   = first_token.strip("<>") if "@" in first_token else ""

    detail = ""
    if msg_type == "delivered":
        h = re.search(r'H=(\S+)', rest)
        detail = h.group(1) if h else ""
    elif msg_type in ("rejected", "deferred"):
        d = re.search(r'(?:SMTP error[^:]*:|rejected after|temporarily rejected)[:\s]+(.+)', rest, re.I)
        if d:
            detail = d.group(1)[:100].strip()
        else:
            parts  = rest.split(None, 1)
            detail = (parts[1][:100] if len(parts) > 1 else rest[:100]).strip()
    elif msg_type == "sent":
        s = re.search(r'S=(\d+)', rest)
        detail = f"{int(s.group(1)) // 1024} KB" if s else ""

    return {
        "timestamp":  ts,
        "message_id": msg_id,
        "sender":     sender,
        "recipient":  recipient,
        "detail":     detail,
    }


_TYPE_MARKERS = {
    " => ": "delivered",
    " ** ": "rejected",
    " == ": "deferred",
    " <= ": "sent",
}


def get_log_tail(limit: int = 300,
                 server_cfg: Optional[Dict[str, Any]] = None) -> List[Dict[str, str]]:
    """Retorna as últimas N linhas do mainlog com tipo detectado automaticamente."""
    candidates = " ".join(f'"{p}"' for p in _LOG_CANDIDATES)
    cmd = (
        f"for f in {candidates}; do "
        f'  [ -f "$f" ] && tail -{limit} "$f" 2>/dev/null && break; '
        f"done"
    )
    raw = _run_raw(cmd, server_cfg=server_cfg)

    entries = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        msg_type = "other"
        for marker, t in _TYPE_MARKERS.items():
            if marker in line:
                msg_type = t
                break
        entries.append({"raw": line, "type": msg_type})

    return list(reversed(entries))


def get_queue_items(server_cfg: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Retorna itens da fila EXIM via `exim -bp`."""
    raw = _run_raw("exim -bp 2>/dev/null | head -1000", server_cfg=server_cfg)
    return _parse_queue(raw)


def get_log_entries(msg_type: str, limit: int = 200,
                    server_cfg: Optional[Dict[str, Any]] = None) -> List[Dict[str, str]]:
    """Retorna entradas do mainlog filtradas por tipo."""
    pattern = _LOG_GREP.get(msg_type)
    if not pattern:
        return []

    candidates = " ".join(f'"{p}"' for p in _LOG_CANDIDATES)
    cmd = (
        f"for f in {candidates}; do "
        f'  [ -f "$f" ] && grep -E \'{pattern}\' "$f" 2>/dev/null | tail -{limit} && break; '
        f"done"
    )
    raw = _run_raw(cmd, server_cfg=server_cfg)

    entries = []
    for line in raw.splitlines():
        parsed = _parse_log_line(line, msg_type)
        if parsed:
            entries.append(parsed)

    return list(reversed(entries))
