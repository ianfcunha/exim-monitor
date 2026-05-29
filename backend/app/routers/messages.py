"""
Endpoints de mensagens — fila e log do EXIM.

GET /api/messages/queue?server_id=
GET /api/messages/tail?server_id=&limit=
GET /api/messages/log?server_id=&type=&limit=
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..crypto import decrypt_secret
from ..database import User, get_db, get_server_owned_by
from ..limiter import limiter
from ..ssh import SSHError, get_log_entries, get_log_tail, get_queue_items

router = APIRouter(prefix="/api/messages", tags=["messages"])


def _get_server_cfg(server_id: Optional[int], db: Session, current_user: User):
    if server_id is None:
        return None
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


@router.get("/queue", summary="Itens na fila EXIM")
@limiter.limit("30/minute")
def queue_messages(
    request: Request,
    response: Response,
    server_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    server_cfg = _get_server_cfg(server_id, db, current_user)
    try:
        return get_queue_items(server_cfg)
    except SSHError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@router.get("/tail", summary="Tail do mainlog — todas as entradas recentes")
@limiter.limit("30/minute")
def log_tail(
    request: Request,
    response: Response,
    server_id: Optional[int] = Query(None),
    limit: int = Query(300, ge=50, le=1000, description="Máximo de linhas"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    server_cfg = _get_server_cfg(server_id, db, current_user)
    try:
        return get_log_tail(limit, server_cfg)
    except SSHError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@router.get("/log", summary="Entradas do mainlog por tipo")
@limiter.limit("30/minute")
def log_messages(
    request: Request,
    response: Response,
    server_id: Optional[int] = Query(None),
    type: str = Query(
        "delivered",
        description="Tipo: delivered | rejected | deferred | sent",
        pattern="^(delivered|rejected|deferred|sent)$",
    ),
    limit: int = Query(100, ge=10, le=500, description="Máximo de entradas"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    server_cfg = _get_server_cfg(server_id, db, current_user)
    try:
        return get_log_entries(type, limit, server_cfg)
    except SSHError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
