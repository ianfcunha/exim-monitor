"""
Coletor de dados com cache em memoria e task em background.

Estrategia de polling:
  - A cada QUICK_INTERVAL segundos  -> coleta leve (--quick)
  - A cada FULL_INTERVAL segundos   -> coleta completa (--json)

Apos cada coleta completa, check_and_alert() avalia se deve disparar
alertas por e-mail ou Telegram com base na configuracao salva no banco.
"""
import asyncio
import logging
from datetime import datetime
from typing import Any, Dict, Optional

from .alerts import check_and_alert
from .config import settings
from .database import SessionLocal, Snapshot
from .ssh import SSHError, run_full, run_quick

logger = logging.getLogger(__name__)

_cache: Dict[str, Any] = {
    "quick": None,
    "quick_ts": None,
    "full": None,
    "full_ts": None,
}


def _save_snapshot(data: Dict[str, Any], mode: str) -> None:
    db = SessionLocal()
    try:
        diag     = data.get("diagnosis", {})
        log_data = data.get("log", {})
        queue    = data.get("queue", {})
        snap = Snapshot(
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
        logger.error("Erro ao salvar snapshot: %s", exc)
        db.rollback()
    finally:
        db.close()


def _cache_valid(key: str, max_age: int) -> bool:
    ts: Optional[datetime] = _cache.get(f"{key}_ts")
    return (
        _cache.get(key) is not None
        and ts is not None
        and (datetime.utcnow() - ts).total_seconds() < max_age
    )


def get_quick(force: bool = False) -> Dict[str, Any]:
    if not force and _cache_valid("quick", settings.quick_interval):
        return _cache["quick"]
    data = run_quick()
    _cache["quick"] = data
    _cache["quick_ts"] = datetime.utcnow()
    _save_snapshot(data, "quick")
    return data


def get_full(force: bool = False) -> Dict[str, Any]:
    if not force and _cache_valid("full", settings.full_interval):
        return _cache["full"]
    data = run_full()
    _cache["full"] = data
    _cache["full_ts"] = datetime.utcnow()
    _save_snapshot(data, "full")
    return data


async def background_collector() -> None:
    ticks_per_full = max(1, settings.full_interval // settings.quick_interval)
    tick = 0

    while True:
        try:
            get_quick(force=True)
            tick += 1

            if tick >= ticks_per_full:
                data = get_full(force=True)
                tick = 0

                # Verifica e dispara alertas apos coleta completa
                diag  = data.get("diagnosis", {})
                queue = data.get("queue", {})
                await check_and_alert(
                    severity    = diag.get("severity", "OK"),
                    problem     = diag.get("problem", "NORMAL"),
                    queue_total = queue.get("total", 0),
                )
                logger.info("Coleta completa concluida")
            else:
                logger.debug("Coleta quick concluida (tick %d/%d)", tick, ticks_per_full)

        except SSHError as exc:
            logger.warning("Coleta falhou (SSH): %s", exc)
        except Exception as exc:
            logger.error("Erro inesperado no coletor: %s", exc, exc_info=True)

        await asyncio.sleep(settings.quick_interval)
