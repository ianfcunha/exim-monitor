"""
Endpoints de status do servidor EXIM.

GET  /api/status/quick    →  dados leves (cache 30s)   — usado pelo heartbeat
GET  /api/status/full     →  dados completos (cache 5min)
POST /api/status/refresh  →  força nova coleta completa ignorando cache
"""
from fastapi import APIRouter, Depends, HTTPException, Request, Response

from ..auth import get_current_user
from ..collector import get_full, get_quick
from ..limiter import limiter
from ..ssh import SSHError

router = APIRouter(prefix="/api/status", tags=["status"])


@router.get("/quick", summary="Status leve para polling de dashboard")
def status_quick(current_user: str = Depends(get_current_user)):
    try:
        return get_quick()
    except SSHError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@router.get("/full", summary="Diagnóstico completo")
def status_full(current_user: str = Depends(get_current_user)):
    try:
        return get_full()
    except SSHError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@router.post("/refresh", summary="Força nova coleta completa")
@limiter.limit("10/minute")         # evita spam de coleta SSH
def refresh(request: Request, response: Response, current_user: str = Depends(get_current_user)):
    try:
        return get_full(force=True)
    except SSHError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
