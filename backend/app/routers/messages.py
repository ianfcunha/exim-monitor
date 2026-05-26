"""
Endpoints de mensagens — fila e log do EXIM.

GET /api/messages/queue          →  itens da fila (exim -bp)
GET /api/messages/log?type=&limit= →  entradas do mainlog por tipo
"""
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from ..auth import get_current_user
from ..limiter import limiter
from ..ssh import SSHError, get_log_entries, get_queue_items

router = APIRouter(prefix="/api/messages", tags=["messages"])


@router.get("/queue", summary="Itens na fila EXIM")
@limiter.limit("30/minute")
def queue_messages(
    request: Request,
    response: Response,
    current_user: str = Depends(get_current_user),
):
    try:
        return get_queue_items()
    except SSHError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@router.get("/log", summary="Entradas do mainlog por tipo")
@limiter.limit("30/minute")
def log_messages(
    request: Request,
    response: Response,
    type: str = Query(
        "delivered",
        description="Tipo: delivered | rejected | deferred | sent",
        pattern="^(delivered|rejected|deferred|sent)$",
    ),
    limit: int = Query(100, ge=10, le=500, description="Máximo de entradas"),
    current_user: str = Depends(get_current_user),
):
    try:
        return get_log_entries(type, limit)
    except SSHError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
