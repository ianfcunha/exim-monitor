"""
Endpoints de histórico de snapshots.

GET /api/history?server_id=         →  série temporal (para gráficos)
GET /api/history/summary?server_id= →  resumo das últimas 24h
"""
from datetime import datetime, timedelta
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import Snapshot, User, get_db, get_server_owned_by, to_utc_iso

router = APIRouter(prefix="/api/history", tags=["history"])


@router.get("/", summary="Série temporal de snapshots")
def get_history(
    hours: int = Query(default=24, ge=1, le=168, description="Janela de horas (máx 7 dias)"),
    mode: Literal["quick", "full"] = Query(default="quick"),
    server_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if server_id is not None:
        server = get_server_owned_by(db, server_id, current_user)
        if not server:
            from fastapi import HTTPException
            raise HTTPException(404, f"Servidor {server_id} não encontrado.")

    since = datetime.utcnow() - timedelta(hours=hours)
    query = (
        db.query(Snapshot)
        .filter(Snapshot.timestamp >= since, Snapshot.mode == mode)
    )
    if server_id is not None:
        query = query.filter(Snapshot.server_id == server_id)

    rows = query.order_by(Snapshot.timestamp.asc()).all()

    return [
        {
            "timestamp":    to_utc_iso(s.timestamp),
            "queue_total":  s.queue_total,
            "severity":     s.severity,
            "problem":      s.problem,
            "delivered":    s.delivered,
            "rejected":     s.rejected,
            "deferred":     s.deferred,
            "recent_sends": s.recent_sends,
        }
        for s in rows
    ]


@router.get("/summary", summary="Resumo das últimas 24h")
def get_summary(
    server_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if server_id is not None:
        server = get_server_owned_by(db, server_id, current_user)
        if not server:
            from fastapi import HTTPException
            raise HTTPException(404, f"Servidor {server_id} não encontrado.")

    since = datetime.utcnow() - timedelta(hours=24)
    query = db.query(Snapshot).filter(Snapshot.timestamp >= since)
    if server_id is not None:
        query = query.filter(Snapshot.server_id == server_id)
    rows = query.all()

    if not rows:
        return {"message": "Sem dados nas últimas 24h"}

    return {
        "snapshots":       len(rows),
        "queue_max":       max(r.queue_total for r in rows),
        "queue_min":       min(r.queue_total for r in rows),
        "queue_avg":       round(sum(r.queue_total for r in rows) / len(rows), 1),
        "delivered_total": sum(r.delivered for r in rows),
        "rejected_total":  sum(r.rejected  for r in rows),
        "deferred_total":  sum(r.deferred  for r in rows),
        "critical_events": sum(1 for r in rows if r.severity == "CRITICAL"),
        "high_events":     sum(1 for r in rows if r.severity == "HIGH"),
    }
