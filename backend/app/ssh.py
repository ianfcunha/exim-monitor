"""
Wrapper SSH para executar o script diag-exim.sh no servidor remoto.
Usa Paramiko com suporte a chave privada e senha.
"""
import json
import os
from typing import Any, Dict, Optional

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
