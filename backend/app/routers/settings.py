"""
Endpoints de configuracao de alertas.

GET  /api/settings/alerts           — retorna config (senhas mascaradas)
PUT  /api/settings/alerts           — salva config completa
POST /api/settings/test/email       — envia e-mail de teste
POST /api/settings/test/telegram    — envia mensagem de teste no Telegram
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from typing import Optional

from fastapi import Query

from ..alerts import send_test_email, send_test_telegram
from ..auth import get_current_user, require_admin
from ..database import AlertHistory, AlertSettings, User, get_alert_settings, get_db, to_utc_iso

router = APIRouter(prefix="/api/settings", tags=["settings"])

MASK = "••••••••"


# ── Schemas ────────────────────────────────────────────────────────────────

class AlertSettingsSchema(BaseModel):
    # Resend (preferencial — substitui SMTP quando configurado)
    resend_api_key: str = ""   # "" = nao alterar se vier mascarado
    # E-mail (SMTP fallback)
    email_enabled: bool = False
    email_to:      str  = ""
    smtp_host:     str  = "smtp.sendgrid.net"
    smtp_port:     int  = Field(587, ge=1, le=65535)
    smtp_user:     str  = "apikey"
    smtp_password: str  = ""   # "" = nao alterar se vier mascarado
    smtp_from:     str  = ""
    smtp_tls:      bool = True
    # Telegram
    telegram_enabled:   bool = False
    telegram_bot_token: str  = ""
    telegram_chat_id:   str  = ""
    # Thresholds
    severity_threshold: str = "HIGH"
    queue_threshold:    int = Field(0, ge=0)
    cooldown_minutes:   int = Field(30, ge=1, le=1440)

    class Config:
        from_attributes = True


def _to_response(cfg: AlertSettings) -> dict:
    """Converte modelo para dict, mascarando campos sensiveis."""
    return {
        "resend_api_key":      MASK if cfg.resend_api_key else "",
        "email_enabled":       cfg.email_enabled,
        "email_to":            cfg.email_to,
        "smtp_host":           cfg.smtp_host,
        "smtp_port":           cfg.smtp_port,
        "smtp_user":           cfg.smtp_user,
        "smtp_password":       MASK if cfg.smtp_password else "",
        "smtp_from":           cfg.smtp_from,
        "smtp_tls":            cfg.smtp_tls,
        "telegram_enabled":    cfg.telegram_enabled,
        "telegram_bot_token":  MASK if cfg.telegram_bot_token else "",
        "telegram_chat_id":    cfg.telegram_chat_id,
        "severity_threshold":  cfg.severity_threshold,
        "queue_threshold":     cfg.queue_threshold,
        "cooldown_minutes":    cfg.cooldown_minutes,
    }


# ── Endpoints ──────────────────────────────────────────────────────────────

@router.get("/alerts", summary="Retorna configuracao de alertas")
def get_settings(
    server_id: Optional[int] = Query(None, description="Servidor especifico; omitido = config padrao/legada"),
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    return _to_response(get_alert_settings(db, server_id=server_id))


@router.put("/alerts", summary="Salva configuracao de alertas")
def update_settings(
    payload: AlertSettingsSchema,
    server_id: Optional[int] = Query(None, description="Servidor especifico; omitido = config padrao/legada"),
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    cfg = get_alert_settings(db, server_id=server_id)

    cfg.email_enabled      = payload.email_enabled
    cfg.email_to           = payload.email_to
    cfg.smtp_host          = payload.smtp_host
    cfg.smtp_port          = payload.smtp_port
    cfg.smtp_user          = payload.smtp_user
    cfg.smtp_from          = payload.smtp_from
    cfg.smtp_tls           = payload.smtp_tls
    cfg.telegram_enabled   = payload.telegram_enabled
    cfg.telegram_chat_id   = payload.telegram_chat_id
    cfg.severity_threshold = payload.severity_threshold
    cfg.queue_threshold    = payload.queue_threshold
    cfg.cooldown_minutes   = payload.cooldown_minutes

    # Atualiza campos sensiveis apenas se vieram preenchidos (nao mascarados)
    if payload.resend_api_key and payload.resend_api_key != MASK:
        cfg.resend_api_key = payload.resend_api_key
    if payload.smtp_password and payload.smtp_password != MASK:
        cfg.smtp_password = payload.smtp_password
    if payload.telegram_bot_token and payload.telegram_bot_token != MASK:
        cfg.telegram_bot_token = payload.telegram_bot_token

    db.commit()
    db.refresh(cfg)
    return _to_response(cfg)


@router.post("/test/email", summary="Envia e-mail de teste")
async def test_email(
    server_id: Optional[int] = Query(None, description="Servidor especifico; omitido = config padrao/legada"),
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    cfg = get_alert_settings(db, server_id=server_id)
    if not cfg.email_to or (not cfg.resend_api_key and not cfg.smtp_password):
        raise HTTPException(400, "Configure e-mail e Resend API key (ou senha SMTP) antes de testar.")
    try:
        await send_test_email(cfg)
    except Exception as exc:
        raise HTTPException(502, f"Falha ao enviar e-mail: {exc}")
    return {"ok": True, "message": f"E-mail de teste enviado para {cfg.email_to}"}


@router.get("/alerts/history", summary="Histórico de alertas disparados")
def get_alert_history(
    limit: int = Query(50, ge=1, le=200, description="Máximo de registros"),
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    rows = (
        db.query(AlertHistory)
        .order_by(AlertHistory.sent_at.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            "id":          r.id,
            "sent_at":     to_utc_iso(r.sent_at),
            "channel":     r.channel,
            "severity":    r.severity,
            "problem":     r.problem,
            "queue_total": r.queue_total,
            "success":     r.success,
            "error_msg":   r.error_msg,
        }
        for r in rows
    ]


@router.post("/test/telegram", summary="Envia mensagem de teste no Telegram")
async def test_telegram(
    server_id: Optional[int] = Query(None, description="Servidor especifico; omitido = config padrao/legada"),
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    cfg = get_alert_settings(db, server_id=server_id)
    if not cfg.telegram_bot_token or not cfg.telegram_chat_id:
        raise HTTPException(400, "Configure bot token e chat ID antes de testar.")
    try:
        await send_test_telegram(cfg)
    except Exception as exc:
        raise HTTPException(502, f"Falha ao enviar Telegram: {exc}")
    return {"ok": True, "message": f"Mensagem enviada ao chat {cfg.telegram_chat_id}"}
