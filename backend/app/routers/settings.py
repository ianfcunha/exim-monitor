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

from ..alerts import (
    TelegramError, channel_status, send_test_email, send_test_telegram, send_test_webhook,
)
from ..auth import get_current_user, require_admin
from ..database import (
    AlertHistory, AlertSettings, Server, User, get_alert_settings,
    get_effective_alert_settings, get_db, get_servers_for_user, to_utc_iso,
)
from ..monthly_report import send_fleet_monthly_report, send_monthly_report
from ..reports import send_weekly_report

router = APIRouter(prefix="/api/settings", tags=["settings"])

MASK = "••••••••"

# Sessão 5: os testes de canal respondiam 502 quando o destino recusava
# a mensagem. O corpo trazia o motivo real ("Unauthorized", "chat not
# found") mas 502 é código de GATEWAY — um proxy no caminho (Caddy,
# Cloudflare) tem licença para trocar o corpo pela própria página de
# erro, e aí o motivo some justamente no caso em que ele importa. Nada
# aqui é falha de gateway: é a configuração que o usuário acabou de
# salvar sendo recusada pelo destino. 422 é a resposta certa e nenhum
# proxy mexe nela.
_UPSTREAM_REJECTED = 422


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
    # Herança de canal (Sessão 4, T10) — só tem efeito num registro de
    # servidor; no registro global é sempre ignorado (o global é a origem).
    email_override:    bool = False
    telegram_override: bool = False
    webhook_override:  bool = False
    # Thresholds
    severity_threshold: str = "HIGH"
    queue_threshold:    int = Field(0, ge=0)
    cooldown_minutes:   int = Field(30, ge=1, le=1440)
    # Relatório semanal por e-mail
    weekly_report_enabled: bool = False
    # Relatório mensal por e-mail (Sessão 3, T3)
    monthly_report_enabled: bool = False
    # Webhook genérico
    webhook_url:    str = ""
    webhook_secret: str = ""   # "" = nao alterar se vier mascarado
    # Custo estimado (Sessão 3, T1) — None = não configurado = nenhuma
    # estimativa financeira aparece em lugar nenhum (ver incident_impact.py)
    cost_per_sysadmin_hour_brl: Optional[float] = Field(None, ge=0)
    cost_per_ticket_brl:        Optional[float] = Field(None, ge=0)

    class Config:
        from_attributes = True


def _to_response(cfg: AlertSettings, effective=None, server_id: Optional[int] = None) -> dict:
    """
    Converte modelo para dict, mascarando campos sensiveis.

    `cfg` são os valores GRAVADOS neste registro — é o que o formulário
    edita. `effective` é a config depois de resolver a herança de canal
    contra o registro global (Sessão 4, T10): é sobre ela que o status
    de cada canal é calculado, porque é ela que vai disparar. Os dois
    coincidem no registro global.
    """
    eff = effective if effective is not None else cfg
    return {
        "is_global":         server_id is None,
        "email_override":    cfg.email_override,
        "telegram_override": cfg.telegram_override,
        "webhook_override":  cfg.webhook_override,
        # Ligado E completo — ligar o interruptor sozinho não conta como
        # canal ativo; `missing` nomeia o que falta para o aviso na tela.
        "channels": channel_status(eff),
        # O que está EM VIGOR neste servidor, para a tela mostrar o valor
        # herdado sem o usuário ter que abrir a configuração global.
        # Segredo herdado nunca viaja: só "tem" ou "não tem".
        "in_effect": {
            "email": {
                "enabled":        eff.email_enabled,
                "email_to":       eff.email_to,
                "smtp_from":      eff.smtp_from,
                "has_credential": bool(eff.resend_api_key or eff.smtp_password),
                "via_resend":     bool(eff.resend_api_key),
            },
            "telegram": {
                "enabled":   eff.telegram_enabled,
                "chat_id":   eff.telegram_chat_id,
                "has_token": bool(eff.telegram_bot_token),
            },
            "webhook": {
                "url":        eff.webhook_url,
                "has_secret": bool(eff.webhook_secret),
            },
        },
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
        "weekly_report_enabled":     cfg.weekly_report_enabled,
        "weekly_report_last_sent_at": to_utc_iso(cfg.weekly_report_last_sent_at),
        "monthly_report_enabled":      cfg.monthly_report_enabled,
        "monthly_report_last_sent_at": to_utc_iso(cfg.monthly_report_last_sent_at),
        "webhook_url":    cfg.webhook_url,
        "webhook_secret": MASK if cfg.webhook_secret else "",
        "cost_per_sysadmin_hour_brl": cfg.cost_per_sysadmin_hour_brl,
        "cost_per_ticket_brl":        cfg.cost_per_ticket_brl,
    }


# ── Endpoints ──────────────────────────────────────────────────────────────

@router.get("/alerts", summary="Retorna configuracao de alertas")
def get_settings(
    server_id: Optional[int] = Query(None, description="Servidor especifico; omitido = config padrao/legada"),
    db: Session = Depends(get_db),
    _: str = Depends(get_current_user),
):
    return _to_response(
        get_alert_settings(db, server_id=server_id),
        effective=get_effective_alert_settings(db, server_id=server_id),
        server_id=server_id,
    )


@router.put("/alerts", summary="Salva configuracao de alertas")
def update_settings(
    payload: AlertSettingsSchema,
    server_id: Optional[int] = Query(None, description="Servidor especifico; omitido = config padrao/legada"),
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    cfg = get_alert_settings(db, server_id=server_id)

    # O registro global é a ORIGEM da herança — não faz sentido ele
    # "sobrescrever" a si mesmo, e gravar True ali deixaria a flag
    # aparecendo na tela sem efeito nenhum.
    if server_id is not None:
        cfg.email_override    = payload.email_override
        cfg.telegram_override = payload.telegram_override
        cfg.webhook_override  = payload.webhook_override

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
    cfg.weekly_report_enabled = payload.weekly_report_enabled
    cfg.monthly_report_enabled = payload.monthly_report_enabled
    cfg.webhook_url         = payload.webhook_url
    cfg.cost_per_sysadmin_hour_brl = payload.cost_per_sysadmin_hour_brl
    cfg.cost_per_ticket_brl        = payload.cost_per_ticket_brl

    # Atualiza campos sensiveis apenas se vieram preenchidos (nao mascarados)
    if payload.resend_api_key and payload.resend_api_key != MASK:
        cfg.resend_api_key = payload.resend_api_key
    if payload.smtp_password and payload.smtp_password != MASK:
        cfg.smtp_password = payload.smtp_password
    if payload.telegram_bot_token and payload.telegram_bot_token != MASK:
        cfg.telegram_bot_token = payload.telegram_bot_token
    if payload.webhook_secret and payload.webhook_secret != MASK:
        cfg.webhook_secret = payload.webhook_secret

    db.commit()
    db.refresh(cfg)
    return _to_response(
        cfg,
        effective=get_effective_alert_settings(db, server_id=server_id),
        server_id=server_id,
    )


@router.post("/test/email", summary="Envia e-mail de teste")
async def test_email(
    server_id: Optional[int] = Query(None, description="Servidor especifico; omitido = config padrao/legada"),
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    cfg = get_effective_alert_settings(db, server_id=server_id)
    missing = channel_status(cfg)["email"]["missing"]
    if missing:
        raise HTTPException(400, f"Configure {' e '.join(missing)} antes de testar.")
    try:
        await send_test_email(cfg)
    except Exception as exc:
        raise HTTPException(_UPSTREAM_REJECTED, f"Falha ao enviar e-mail: {exc}")
    return {"ok": True, "message": f"E-mail de teste enviado para {cfg.email_to}"}


@router.get("/alerts/history", summary="Histórico de alertas disparados")
def get_alert_history(
    limit: int = Query(50, ge=1, le=200, description="Máximo de registros"),
    server_id: Optional[int] = Query(None, description="Servidor específico; omitido = toda a frota do usuário"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Sessão 5: esta rota ignorava escopo por completo — devolvia o
    histórico de TODOS os servidores do banco, inclusive de quem o
    usuário não tem acesso, e sem dizer de qual servidor era cada linha.
    Agora respeita o escopo da interface (`?server=` na URL) e nomeia o
    servidor de cada alerta.
    """
    allowed = {s.id: s.name for s in get_servers_for_user(db, current_user)}
    if server_id is not None:
        if server_id not in allowed:
            raise HTTPException(404, f"Servidor {server_id} não encontrado.")
        allowed = {server_id: allowed[server_id]}

    rows = (
        db.query(AlertHistory)
        .filter(AlertHistory.server_id.in_(allowed.keys()))
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
            "incident_id": r.incident_id,
            "server_id":   r.server_id,
            "server_name": allowed.get(r.server_id),
            "queue_total": r.queue_total,
            "success":     r.success,
            "error_msg":   r.error_msg,
        }
        for r in rows
    ]


@router.post("/test/weekly-report", summary="Dispara o relatório semanal imediatamente (teste)")
async def test_weekly_report(
    server_id: Optional[int] = Query(None, description="Servidor especifico; omitido = config padrao/legada"),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """
    Dispara o relatório semanal fora do agendamento normal — usado para
    validar conteúdo/entrega sem esperar o ciclo semanal. mark_sent=False:
    não mexe em weekly_report_last_sent_at, então não atrasa o próximo
    envio automático.
    """
    cfg = get_alert_settings(db, server_id=server_id)
    if not cfg.weekly_report_enabled:
        raise HTTPException(400, "Ative o relatório semanal antes de testar.")
    channels = get_effective_alert_settings(db, server_id=server_id)
    missing = channel_status(channels)["email"]["missing"]
    if missing:
        raise HTTPException(400, f"Configure {' e '.join(missing)} antes de testar.")

    server_name = "servidor padrão"
    if server_id is not None:
        server = db.get(Server, server_id)
        server_name = server.name if server else server_name

    sent = await send_weekly_report(server_id, server_name, mark_sent=False)
    if not sent:
        raise HTTPException(_UPSTREAM_REJECTED, "Falha ao enviar o relatório de teste — veja os logs do backend.")
    return {"ok": True, "message": f"Relatório semanal de teste enviado para {channels.email_to}"}


@router.post("/test/monthly-report", summary="Dispara o relatório mensal imediatamente (teste)")
async def test_monthly_report(
    server_id: Optional[int] = Query(None, description="Servidor específico; omitido = frota inteira"),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Mesma lógica de test_weekly_report — mark_sent=False não mexe em
    monthly_report_last_sent_at, então não atrasa o próximo envio real
    do dia 1. server_id omitido testa o relatório DA FROTA (registro
    global de AlertSettings), não um servidor específico."""
    cfg = get_alert_settings(db, server_id=server_id)
    if not cfg.monthly_report_enabled:
        raise HTTPException(400, "Ative o relatório mensal antes de testar.")
    channels = get_effective_alert_settings(db, server_id=server_id)
    missing = channel_status(channels)["email"]["missing"]
    if missing:
        raise HTTPException(400, f"Configure {' e '.join(missing)} antes de testar.")

    if server_id is not None:
        server = db.get(Server, server_id)
        sent = await send_monthly_report(server_id, server.name if server else "servidor", mark_sent=False)
    else:
        sent = await send_fleet_monthly_report(mark_sent=False)

    if not sent:
        raise HTTPException(_UPSTREAM_REJECTED, "Falha ao enviar o relatório de teste — veja os logs do backend.")
    return {"ok": True, "message": f"Relatório mensal de teste enviado para {channels.email_to}"}


@router.post("/test/telegram", summary="Envia mensagem de teste no Telegram")
async def test_telegram(
    server_id: Optional[int] = Query(None, description="Servidor especifico; omitido = config padrao/legada"),
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    cfg = get_effective_alert_settings(db, server_id=server_id)
    missing = channel_status(cfg)["telegram"]["missing"]
    if missing:
        raise HTTPException(400, f"Configure {' e '.join(missing)} antes de testar.")
    try:
        await send_test_telegram(cfg)
    except TelegramError as exc:
        # O motivo vem da própria API do Telegram ("chat not found",
        # "Unauthorized") — é o que diz se o erro foi no chat ID ou no
        # token. Antes só chegava "HTTP Error 400: Bad Request".
        raise HTTPException(_UPSTREAM_REJECTED, f"O Telegram recusou a mensagem: {exc}")
    except Exception as exc:
        raise HTTPException(_UPSTREAM_REJECTED, f"Falha ao falar com o Telegram: {exc}")
    return {"ok": True, "message": f"Mensagem enviada ao chat {cfg.telegram_chat_id}"}


@router.post("/test/webhook", summary="Envia webhook de teste")
async def test_webhook(
    server_id: Optional[int] = Query(None, description="Servidor especifico; omitido = config padrao/legada"),
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    cfg = get_effective_alert_settings(db, server_id=server_id)
    if not cfg.webhook_url:
        raise HTTPException(400, "Configure a URL do webhook antes de testar.")
    missing = channel_status(cfg)["webhook"]["missing"]
    if missing:
        raise HTTPException(400, f"Configure {' e '.join(missing)} antes de testar.")

    server_name = None
    if server_id is not None:
        server = db.get(Server, server_id)
        server_name = server.name if server else None

    try:
        await send_test_webhook(cfg, server_id=server_id, server_name=server_name)
    except Exception as exc:
        raise HTTPException(_UPSTREAM_REJECTED, f"Falha ao enviar webhook: {exc}")
    return {"ok": True, "message": f"Webhook de teste enviado para {cfg.webhook_url}"}
