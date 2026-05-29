"""
Endpoints de status do servidor EXIM.

GET  /api/status/quick?server_id=   →  dados leves (cache 30s)
GET  /api/status/full?server_id=    →  dados completos (cache 5min)
POST /api/status/refresh?server_id= →  força nova coleta completa
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..collector import get_full, get_quick
from ..crypto import decrypt_secret
from ..database import User, get_db, get_server_owned_by
from ..limiter import limiter
from ..ssh import SSHError, run_full, run_quick

router = APIRouter(prefix="/api/status", tags=["status"])


def _resolve_server_cfg(server_id: Optional[int], db: Session, current_user: User):
    """
    Retorna (server_cfg_dict | None, resolved_server_id).
    None = usar configuração do .env (retrocompatibilidade).
    """
    if server_id is None:
        return None, None

    server = get_server_owned_by(db, server_id, current_user)
    if not server:
        raise HTTPException(404, f"Servidor {server_id} não encontrado.")

    cfg = {
        "host":          server.host,
        "port":          server.port,
        "ssh_user":      server.ssh_user,
        "ssh_auth_type": server.ssh_auth_type,
        "ssh_secret":    decrypt_secret(server.ssh_secret),
        "script_path":   server.script_path,
    }
    return cfg, server_id


@router.get("/quick", summary="Status leve para polling de dashboard")
def status_quick(
    server_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _resolve_server_cfg(server_id, db, current_user)  # valida acesso
    data = get_quick(server_id)
    if data is None:
        raise HTTPException(503, "Dados ainda não disponíveis — aguarde o próximo ciclo de coleta.")
    return data


@router.get("/full", summary="Diagnóstico completo")
def status_full(
    server_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _resolve_server_cfg(server_id, db, current_user)
    data = get_full(server_id)
    if data is None:
        raise HTTPException(503, "Dados ainda não disponíveis — aguarde o próximo ciclo de coleta.")
    return data


@router.post("/refresh", summary="Força nova coleta completa")
@limiter.limit("10/minute")
def refresh(
    request: Request,
    response: Response,
    server_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    server_cfg, sid = _resolve_server_cfg(server_id, db, current_user)
    try:
        import asyncio
        from ..collector import _collect_server, _default_cfg_from_settings

        if server_cfg:
            cfg_with_id = {"server_id": sid, **server_cfg}
        else:
            from ..config import settings
            cfg_with_id = {
                "server_id":     None,
                "host":          settings.ssh_host,
                "port":          settings.ssh_port,
                "ssh_user":      settings.ssh_user,
                "ssh_auth_type": "key" if not settings.ssh_password else "password",
                "ssh_secret":    settings.ssh_password or "",
                "script_path":   settings.script_path,
            }

        # Coleta full síncrona para o refresh manual
        from ..ssh import run_full as ssh_run_full
        data = ssh_run_full(server_cfg)

        # Atualiza cache diretamente
        from ..collector import _cache, _empty_cache_entry, _save_snapshot
        from datetime import datetime
        if sid not in _cache:
            _cache[sid] = _empty_cache_entry()
        _cache[sid]["full"]    = data
        _cache[sid]["full_ts"] = datetime.utcnow()
        _save_snapshot(data, "full", sid)

        return data
    except SSHError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
