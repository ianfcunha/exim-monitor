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
from ..collector import _cache, _empty_cache_entry, _save_snapshot, get_full, get_quick
from ..crypto import decrypt_secret
from ..database import User, get_db, get_server_owned_by, get_servers_for_user
from ..limiter import limiter
from ..ssh import SSHError, run_full as ssh_run_full

router = APIRouter(prefix="/api/status", tags=["status"])


def _resolve_server_id(server_id: Optional[int], db: Session, current_user: User) -> Optional[int]:
    """
    Resolve o server_id efetivo:
    - Se fornecido: valida que o usuário tem acesso e retorna.
    - Se None: retorna o ID do primeiro servidor ativo do usuário.
    """
    if server_id is not None:
        server = get_server_owned_by(db, server_id, current_user)
        if not server:
            raise HTTPException(404, f"Servidor {server_id} não encontrado.")
        return server_id

    # Fallback: primeiro servidor ativo do usuário
    servers = get_servers_for_user(db, current_user)
    if servers:
        return servers[0].id

    return None  # sem servidores cadastrados ainda


def _get_server_cfg(server_id: int, db: Session, current_user: User) -> dict:
    """Retorna dict de configuração SSH para o servidor."""
    server = get_server_owned_by(db, server_id, current_user)
    if not server:
        raise HTTPException(404, f"Servidor {server_id} não encontrado.")
    return {
        "host":          server.host,
        "port":          server.port,
        "ssh_user":      server.ssh_user,
        "ssh_auth_type": server.ssh_auth_type,
        "ssh_secret":    decrypt_secret(server.ssh_secret),
        "script_path":   server.script_path,
    }


@router.get("/quick", summary="Status leve para polling de dashboard")
def status_quick(
    server_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    sid = _resolve_server_id(server_id, db, current_user)
    data = get_quick(sid)
    if data is None:
        raise HTTPException(503, "Dados ainda não disponíveis — aguarde o próximo ciclo de coleta.")
    return data


@router.get("/full", summary="Diagnóstico completo")
def status_full(
    server_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    sid = _resolve_server_id(server_id, db, current_user)
    data = get_full(sid)
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
    from datetime import datetime

    sid = _resolve_server_id(server_id, db, current_user)
    if sid is None:
        raise HTTPException(400, "Nenhum servidor configurado.")

    server_cfg = _get_server_cfg(sid, db, current_user)

    try:
        data = ssh_run_full(server_cfg)

        if sid not in _cache:
            _cache[sid] = _empty_cache_entry()
        _cache[sid]["full"]    = data
        _cache[sid]["full_ts"] = datetime.utcnow()
        _save_snapshot(data, "full", sid)

        return data
    except SSHError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
