"""
Sistema de alertas do EXIM Monitor.

Canais suportados:
  - E-mail via Resend API (preferencial — basta configurar resend_api_key)
  - E-mail via SMTP (fallback — SendGrid, Mailgun, Gmail, qualquer provedor)
  - Telegram via Bot API
  - Webhook genérico (POST JSON, opcionalmente assinado em HMAC-SHA256)

Logica de disparo:
  1. Severidade sobe para nivel >= threshold  (OK->HIGH, OK->CRITICAL, HIGH->CRITICAL)
  2. Fila ultrapassa queue_threshold (se > 0)
  3. Cooldown por tipo de alerta evita flood no mesmo evento

Toda IO de rede e executada em thread separada (asyncio.to_thread) para
nao bloquear o event loop.
"""
import asyncio
import hashlib
import hmac
import json
import logging
import smtplib
import urllib.request
from datetime import datetime, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Dict, Optional

from .database import AlertHistory, AlertSettings, Server, SessionLocal, get_alert_settings

logger = logging.getLogger(__name__)

# ── Ranking de severidade ──────────────────────────────────────────────────
_SEV_RANK = {"OK": 0, "LOW": 1, "MEDIUM": 2, "HIGH": 3, "CRITICAL": 4}

# ── Estado de debounce em memoria, por servidor ─────────────────────────────
# Indexado por server_id (None = servidor legado/config padrao). Cada servidor
# tem seu proprio "ultima severidade"/cooldown — severidade de um servidor
# nao deve afetar o debounce de outro.
_state: Dict[Optional[int], dict] = {}


def _server_state(server_id: Optional[int]) -> dict:
    """Retorna (criando se necessario) o dict de estado do servidor."""
    if server_id not in _state:
        _state[server_id] = {
            "last_severity": "OK",
            "email_sent_at": None,
            "telegram_sent_at": None,
            "webhook_sent_at": None,
        }
    return _state[server_id]


# ── Helpers de envio (bloqueantes — rodam em thread) ──────────────────────

def _email_body_html(severity: str, problem: str, queue_total: int, hostname: str) -> str:
    color = {"CRITICAL": "#A32D2D", "HIGH": "#854F0B"}.get(severity, "#185FA5")
    badge_bg = {"CRITICAL": "#FCEBEB", "HIGH": "#FAEEDA"}.get(severity, "#E6F1FB")
    return f"""
<!DOCTYPE html><html><body style="font-family:sans-serif;background:#f8f8f6;margin:0;padding:24px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;
            border:0.5px solid #d3d1c7;overflow:hidden">
  <div style="background:{color};padding:20px 28px">
    <h1 style="color:#fff;margin:0;font-size:18px">
      EXIM Monitor — Alerta de {severity}
    </h1>
  </div>
  <div style="padding:24px 28px">
    <p style="margin:0 0 16px;color:#2c2c2a;font-size:15px">
      Um evento foi detectado no servidor <strong>{hostname}</strong>:
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr>
        <td style="padding:8px 0;color:#888;border-bottom:0.5px solid #eee">Severidade</td>
        <td style="padding:8px 0;border-bottom:0.5px solid #eee">
          <span style="background:{badge_bg};color:{color};padding:2px 10px;
                       border-radius:20px;font-weight:600">{severity}</span>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#888;border-bottom:0.5px solid #eee">Problema</td>
        <td style="padding:8px 0;border-bottom:0.5px solid #eee;font-weight:600">{problem}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#888">Fila atual</td>
        <td style="padding:8px 0;font-weight:600">{queue_total} mensagens</td>
      </tr>
    </table>
    <p style="margin:20px 0 0;color:#888;font-size:12px">
      Abra o dashboard para tomar uma acao corretiva.
    </p>
  </div>
  <div style="background:#f8f8f6;padding:12px 28px;font-size:11px;color:#aaa">
    EXIM Monitor &mdash; enviado automaticamente em {datetime.utcnow().strftime("%d/%m/%Y %H:%M")} UTC
  </div>
</div>
</body></html>"""


def _send_raw_email(cfg: AlertSettings, subject: str, html_body: str) -> None:
    """
    Transporte de e-mail (Resend, com fallback SMTP) — nao sabe nada sobre
    alerta/severidade, so envia subject+html. Reaproveitado por qualquer
    feature que precise mandar e-mail com a config ja salva (alertas de
    diagnostico, relatorio semanal, etc.) sem duplicar a logica de
    Resend-vs-SMTP em cada lugar.
    """
    if cfg.resend_api_key:
        import resend
        resend.api_key = cfg.resend_api_key
        resend.Emails.send({
            "from":    cfg.smtp_from or "EXIM Monitor <alertas@resend.dev>",
            "to":      [cfg.email_to],
            "subject": subject,
            "html":    html_body,
        })
        logger.info("E-mail (Resend) enviado para %s: %s", cfg.email_to, subject)
    else:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"]    = cfg.smtp_from
        msg["To"]      = cfg.email_to
        msg.attach(MIMEText(html_body, "html", "utf-8"))

        with smtplib.SMTP(cfg.smtp_host, cfg.smtp_port, timeout=15) as server:
            server.ehlo()
            if cfg.smtp_tls:
                server.starttls()
                server.ehlo()
            if cfg.smtp_user and cfg.smtp_password:
                server.login(cfg.smtp_user, cfg.smtp_password)
            server.sendmail(cfg.smtp_from, cfg.email_to, msg.as_string())
        logger.info("E-mail (SMTP) enviado para %s: %s", cfg.email_to, subject)


def _send_email_sync(cfg: AlertSettings, severity: str, problem: str,
                     queue_total: int) -> None:
    hostname = "servidor EXIM"
    subject  = f"[EXIM Monitor] Alerta {severity}: {problem}"
    body     = _email_body_html(severity, problem, queue_total, hostname)
    _send_raw_email(cfg, subject, body)


def _send_telegram_sync(cfg: AlertSettings, severity: str, problem: str,
                        queue_total: int) -> None:
    icon = {"CRITICAL": "🔴", "HIGH": "🟠"}.get(severity, "🟡")
    text = (
        f"{icon} <b>EXIM Monitor — {severity}</b>\n\n"
        f"<b>Problema:</b> <code>{problem}</code>\n"
        f"<b>Fila:</b> {queue_total} mensagens\n"
        f"<b>Hora:</b> {datetime.utcnow().strftime('%d/%m/%Y %H:%M')} UTC\n\n"
        f"Acesse o dashboard para corrigir."
    )
    url = f"https://api.telegram.org/bot{cfg.telegram_bot_token}/sendMessage"
    payload = json.dumps({
        "chat_id": cfg.telegram_chat_id,
        "text": text,
        "parse_mode": "HTML",
    }).encode()
    req = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json"},
    )
    urllib.request.urlopen(req, timeout=10)
    logger.info("Alerta Telegram enviado para chat %s", cfg.telegram_chat_id)


def _send_webhook_sync(cfg: AlertSettings, severity: str, problem: str, queue_total: int,
                       server_id: Optional[int], server_name: Optional[str]) -> None:
    """
    POST JSON genérico — integra com qualquer receptor (Slack incoming
    webhook não entende esse formato bruto, mas serviços tipo n8n/Zapier/
    endpoint proprio do cliente sim). Assina o corpo em HMAC-SHA256 quando
    webhook_secret está configurado, no mesmo espírito de webhooks do
    Stripe/GitHub — header X-EximMonitor-Signature = "sha256=<hex>".
    """
    payload = {
        "severity":    severity,
        "problem":     problem,
        "queue_total": queue_total,
        "server_id":   server_id,
        "server_name": server_name,
        "timestamp":   datetime.utcnow().isoformat() + "Z",
    }
    body = json.dumps(payload).encode()
    headers = {"Content-Type": "application/json"}
    if cfg.webhook_secret:
        signature = hmac.new(cfg.webhook_secret.encode(), body, hashlib.sha256).hexdigest()
        headers["X-EximMonitor-Signature"] = f"sha256={signature}"
    req = urllib.request.Request(cfg.webhook_url, data=body, headers=headers)
    urllib.request.urlopen(req, timeout=10)
    logger.info("Webhook enviado para %s", cfg.webhook_url)


# ── Histórico de alertas ───────────────────────────────────────────────────

def _record_history(channel: str, severity: str, problem: str,
                    queue_total: int, success: bool, error_msg: Optional[str] = None,
                    server_id: Optional[int] = None) -> None:
    """Persiste um registro no histórico de alertas (fire-and-forget seguro)."""
    try:
        db = SessionLocal()
        try:
            entry = AlertHistory(
                server_id=server_id,
                channel=channel,
                severity=severity,
                problem=problem,
                queue_total=queue_total,
                success=success,
                error_msg=error_msg,
            )
            db.add(entry)
            db.commit()
        finally:
            db.close()
    except Exception as exc:
        logger.warning("Não foi possível registrar histórico de alerta: %s", exc)


# ── API publica ────────────────────────────────────────────────────────────

async def check_and_alert(severity: str, problem: str, queue_total: int,
                          server_id: Optional[int] = None) -> None:
    """
    Chamado apos cada coleta completa (full) de um servidor.
    Verifica se deve disparar alertas e os envia de forma assincrona.

    server_id identifica de qual servidor veio o evento — config e cooldown
    sao isolados por servidor, para a severidade de um nao afetar o debounce
    de outro (server_id=None usa a config/estado "padrao"/legado).
    """
    db = SessionLocal()
    try:
        cfg = get_alert_settings(db, server_id=server_id)
        state = _server_state(server_id)
        now = datetime.utcnow()
        cooldown = timedelta(minutes=cfg.cooldown_minutes)

        prev_rank = _SEV_RANK.get(state["last_severity"], 0)
        curr_rank = _SEV_RANK.get(severity, 0)
        thr_rank  = _SEV_RANK.get(cfg.severity_threshold, 3)

        # Dispara se:
        #   (a) severidade subiu e esta acima do threshold, ou
        #   (b) fila ultrapassou queue_threshold (se habilitado)
        severity_trigger = (curr_rank >= thr_rank and curr_rank > prev_rank)
        queue_trigger = (
            cfg.queue_threshold > 0
            and queue_total >= cfg.queue_threshold
            and (prev_rank < thr_rank)   # nao duplicar com severity_trigger
        )

        state["last_severity"] = severity

        if not (severity_trigger or queue_trigger):
            return

        # ── E-mail ────────────────────────────────────────────────────
        if cfg.email_enabled and cfg.email_to and cfg.smtp_password:
            last = state["email_sent_at"]
            if last is None or (now - last) >= cooldown:
                try:
                    await asyncio.to_thread(
                        _send_email_sync, cfg, severity, problem, queue_total
                    )
                    state["email_sent_at"] = now
                    _record_history("email", severity, problem, queue_total, True, server_id=server_id)
                except Exception as exc:
                    logger.error("Falha ao enviar e-mail: %s", exc)
                    _record_history("email", severity, problem, queue_total, False, str(exc)[:500], server_id=server_id)

        # ── Telegram ──────────────────────────────────────────────────
        if cfg.telegram_enabled and cfg.telegram_bot_token and cfg.telegram_chat_id:
            last = state["telegram_sent_at"]
            if last is None or (now - last) >= cooldown:
                try:
                    await asyncio.to_thread(
                        _send_telegram_sync, cfg, severity, problem, queue_total
                    )
                    state["telegram_sent_at"] = now
                    _record_history("telegram", severity, problem, queue_total, True, server_id=server_id)
                except Exception as exc:
                    logger.error("Falha ao enviar Telegram: %s", exc)
                    _record_history("telegram", severity, problem, queue_total, False, str(exc)[:500], server_id=server_id)

        # ── Webhook ───────────────────────────────────────────────────
        if cfg.webhook_url:
            last = state["webhook_sent_at"]
            if last is None or (now - last) >= cooldown:
                server_name = None
                if server_id is not None:
                    server = db.get(Server, server_id)
                    server_name = server.name if server else None
                try:
                    await asyncio.to_thread(
                        _send_webhook_sync, cfg, severity, problem, queue_total, server_id, server_name
                    )
                    state["webhook_sent_at"] = now
                    _record_history("webhook", severity, problem, queue_total, True, server_id=server_id)
                except Exception as exc:
                    logger.error("Falha ao enviar webhook: %s", exc)
                    _record_history("webhook", severity, problem, queue_total, False, str(exc)[:500], server_id=server_id)

    finally:
        db.close()


async def send_test_email(cfg: AlertSettings) -> None:
    """Envia e-mail de teste — usado pelo endpoint POST /api/settings/test/email."""
    await asyncio.to_thread(
        _send_email_sync, cfg, "HIGH", "TESTE_ALERTA", 42
    )


async def send_test_telegram(cfg: AlertSettings) -> None:
    """Envia mensagem de teste no Telegram."""
    await asyncio.to_thread(
        _send_telegram_sync, cfg, "HIGH", "TESTE_ALERTA", 42
    )


async def send_test_webhook(cfg: AlertSettings, server_id: Optional[int] = None,
                            server_name: Optional[str] = None) -> None:
    """Envia webhook de teste — usado pelo endpoint POST /api/settings/test/webhook."""
    await asyncio.to_thread(
        _send_webhook_sync, cfg, "HIGH", "TESTE_ALERTA", 42, server_id, server_name
    )
