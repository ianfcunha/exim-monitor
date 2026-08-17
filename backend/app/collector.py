"""
Coletor de dados com cache em memória e task em background.

Estratégia de polling por servidor:
  - A cada QUICK_INTERVAL segundos  → coleta leve (--quick) em todos os servidores ativos
  - A cada FULL_INTERVAL segundos   → coleta completa (--json) em todos os servidores ativos

Cache indexado por server_id. Acesso via get_quick(server_id) / get_full(server_id).
Retrocompatibilidade: server_id=None usa configuração do .env.
"""
import asyncio
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from .alerts import check_and_alert
from .config import settings
from .crypto import decrypt_secret
from .database import Server, SessionLocal, Snapshot
from .ssh import SSHError, run_full, run_quick

logger = logging.getLogger(__name__)

# Cache indexado por server_id (None = servidor do .env)
_cache: Dict[Optional[int], Dict[str, Any]] = {}


def _empty_cache_entry() -> Dict[str, Any]:
    return {
        "quick":    None,
        "quick_ts": None,
        "full":     None,
        "full_ts":  None,
    }


def _cache_valid(server_id: Optional[int], key: str, max_age: int) -> bool:
    entry = _cache.get(server_id, {})
    ts: Optional[datetime] = entry.get(f"{key}_ts")
    return (
        entry.get(key) is not None
        and ts is not None
        and (datetime.utcnow() - ts).total_seconds() < max_age
    )


def _get_active_servers() -> List[Dict[str, Any]]:
    """Retorna lista de configs de servidores ativos do banco."""
    db = SessionLocal()
    try:
        servers = db.query(Server).filter(Server.is_enabled == True).all()
        result = []
        for s in servers:
            result.append({
                "server_id":   s.id,
                "host":        s.host,
                "port":        s.port,
                "ssh_user":    s.ssh_user,
                "ssh_auth_type": s.ssh_auth_type,
                "ssh_secret":  decrypt_secret(s.ssh_secret),
                "script_path": s.script_path,
            })
        return result
    finally:
        db.close()


def _save_snapshot(data: Dict[str, Any], mode: str, server_id: Optional[int]) -> None:
    db = SessionLocal()
    try:
        diag     = data.get("diagnosis", {})
        log_data = data.get("log", {})
        queue    = data.get("queue", {})
        snap = Snapshot(
            server_id    = server_id,
            timestamp    = datetime.utcnow(),
            mode         = mode,
            queue_total  = queue.get("total", 0),
            severity     = diag.get("severity", "OK"),
            problem      = diag.get("problem", "NORMAL"),
            delivered    = log_data.get("delivered", 0),
            rejected     = log_data.get("rejected", 0),
            deferred     = log_data.get("deferred", 0),
            recent_sends = log_data.get("recent_sends", 0),
            data         = data,
        )
        db.add(snap)
        db.commit()
    except Exception as exc:
        logger.error("Erro ao salvar snapshot (server_id=%s): %s", server_id, exc)
        db.rollback()
    finally:
        db.close()


def _update_server_ssh_status(server_id: int, status: str, error: Optional[str] = None) -> None:
    db = SessionLocal()
    try:
        server = db.get(Server, server_id)
        if server:
            server.ssh_status       = status
            server.ssh_error_msg    = error
            server.last_connected_at = datetime.utcnow() if status == "ok" else server.last_connected_at
            db.commit()
    except Exception as exc:
        logger.warning("Não foi possível atualizar ssh_status do servidor %s: %s", server_id, exc)
    finally:
        db.close()


# ── API de cache ───────────────────────────────────────────────────────────

def get_quick(server_id: Optional[int] = None, force: bool = False) -> Optional[Dict[str, Any]]:
    """Retorna dados quick do cache para o servidor especificado."""
    if not force and _cache_valid(server_id, "quick", settings.quick_interval):
        return _cache[server_id]["quick"]

    # Se não há dados em cache ainda, retorna None (dashboard mostra loading)
    return _cache.get(server_id, {}).get("quick")


def get_full(server_id: Optional[int] = None, force: bool = False) -> Optional[Dict[str, Any]]:
    """Retorna dados full do cache para o servidor especificado."""
    if not force and _cache_valid(server_id, "full", settings.full_interval):
        return _cache[server_id]["full"]
    return _cache.get(server_id, {}).get("full")


async def _collect_server(server_cfg: Dict[str, Any], mode: str) -> None:
    """Coleta dados de um único servidor em thread separada."""
    server_id = server_cfg["server_id"]
    cfg = {k: v for k, v in server_cfg.items() if k != "server_id"}

    try:
        if mode == "quick":
            data = await asyncio.to_thread(run_quick, cfg)
        else:
            data = await asyncio.to_thread(run_full, cfg)

        if server_id not in _cache:
            _cache[server_id] = _empty_cache_entry()

        _cache[server_id][mode]       = data
        _cache[server_id][f"{mode}_ts"] = datetime.utcnow()
        _save_snapshot(data, mode, server_id)
        _update_server_ssh_status(server_id, "ok")

        if mode == "full":
            diag  = data.get("diagnosis", {})
            queue = data.get("queue", {})
            await check_and_alert(
                severity    = diag.get("severity", "OK"),
                problem     = diag.get("problem", "NORMAL"),
                queue_total = queue.get("total", 0),
                server_id   = server_id,
            )

    except SSHError as exc:
        logger.warning("Coleta SSH falhou (server_id=%s): %s", server_id, exc)
        _update_server_ssh_status(server_id, "error", str(exc)[:500])
    except Exception as exc:
        logger.error("Erro inesperado na coleta (server_id=%s): %s", server_id, exc, exc_info=True)
        _update_server_ssh_status(server_id, "error", str(exc)[:500])


async def background_collector() -> None:
    """
    Loop principal: coleta todos os servidores ativos em paralelo.
    Fallback para servidor do .env se o banco ainda não tiver servidores.
    """
    ticks_per_full = max(1, settings.full_interval // settings.quick_interval)
    tick = 0

    while True:
        try:
            servers = _get_active_servers()

            if not servers:
                # Retrocompatibilidade: usa configuração do .env diretamente
                servers = [{
                    "server_id":     None,
                    "host":          settings.ssh_host,
                    "port":          settings.ssh_port,
                    "ssh_user":      settings.ssh_user,
                    "ssh_auth_type": "key" if not settings.ssh_password else "password",
                    "ssh_secret":    settings.ssh_password or "",
                    "script_path":   settings.script_path,
                }]

            mode = "full" if tick == 0 else "quick"
            tasks = [_collect_server(s, mode) for s in servers]
            await asyncio.gather(*tasks, return_exceptions=True)

            tick = (tick + 1) % ticks_per_full
            logger.debug("Ciclo %s concluído — %d servidor(es)", mode, len(servers))

        except Exception as exc:
            logger.error("Erro no loop do coletor: %s", exc, exc_info=True)

        await asyncio.sleep(settings.quick_interval)
