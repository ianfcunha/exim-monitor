"""
Endpoints de mensagens — fila e log do EXIM.

GET /api/messages/queue?server_id=
GET /api/messages/tail?server_id=&limit=
GET /api/messages/log?server_id=&type=&limit=
GET /api/messages/export?server_id=&start=&end=&account=&type=&format=
"""
import csv
import io
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..crypto import decrypt_secret
from ..database import User, get_db, get_server_owned_by
from ..limiter import limiter
from ..ssh import SSHError, get_log_entries, get_log_entries_ranged, get_log_tail, get_queue_items

router = APIRouter(prefix="/api/messages", tags=["messages"])


def _get_server_cfg(server_id: Optional[int], db: Session, current_user: User):
    if server_id is None:
        return None
    server = get_server_owned_by(db, server_id, current_user)
    if not server:
        raise HTTPException(404, f"Servidor {server_id} não encontrado.")
    return {
        "host":                 server.host,
        "port":                 server.port,
        "ssh_user":             server.ssh_user,
        "ssh_auth_type":        server.ssh_auth_type,
        "ssh_secret":           decrypt_secret(server.ssh_secret),
        "script_path":          server.script_path,
        "host_key_fingerprint": server.ssh_host_key_fingerprint,
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


@router.get("/export", summary="Exporta entradas do mainlog por período/conta (CSV ou texto)")
@limiter.limit("10/minute")
def export_messages(
    request: Request,
    response: Response,
    server_id: Optional[int] = Query(None),
    start: date = Query(..., description="Data inicial (YYYY-MM-DD)"),
    end: date = Query(..., description="Data final (YYYY-MM-DD)"),
    account: Optional[str] = Query(None, description="E-mail ou parte local — remetente OU destinatário"),
    type: Optional[str] = Query(
        None,
        description="delivered | rejected | deferred | sent — omitido traz todos os tipos",
        pattern="^(delivered|rejected|deferred|sent)$",
    ),
    format: str = Query("csv", pattern="^(csv|txt)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    server_cfg = _get_server_cfg(server_id, db, current_user)
    try:
        entries = get_log_entries_ranged(
            start.isoformat(), end.isoformat(),
            account=account, msg_type=type, server_cfg=server_cfg,
        )
    except SSHError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    filename_base = f"exim-log_{start.isoformat()}_{end.isoformat()}"

    if format == "txt":
        body = "\n".join(e.get("raw", "") for e in entries)
        media_type = "text/plain"
        filename = f"{filename_base}.log"
    else:
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["timestamp", "type", "sender", "recipient", "raw"])
        for e in entries:
            writer.writerow([
                e.get("timestamp", ""), e.get("type", ""),
                e.get("sender", ""), e.get("recipient", ""), e.get("raw", ""),
            ])
        body = buf.getvalue()
        media_type = "text/csv"
        filename = f"{filename_base}.csv"

    return Response(
        content=body,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
