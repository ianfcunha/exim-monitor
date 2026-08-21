"""
Sessão 2, Tarefa 4 — notificação de incidentes (antes da UI: ninguém
abre um painel de e-mail quando está tudo bem, o produto é o alerta que
chega onde a pessoa já está).

Anti-ruído — só notifica em 3 momentos, nunca a cada ciclo de detecção:
  - "opened"    → incidente novo
  - "escalated" → mesma fingerprint, métrica piorou (evento IncidentEvent
                  já registrado por incident_engine.py antes de chamar isto)
  - "resolved"  → incidente fechado (manual ou automático)

Aceite (T4): um incidente que abre, agrava e resolve gera exatamente 3
mensagens por canal habilitado — nunca uma por ciclo de detecção.

Silenciamento, em ordem de checagem (qualquer um deles corta TODAS as
mensagens deste evento, nenhum canal é tentado):
  1. tipo mudo neste servidor (muted_incident_types)
  2. severidade desligada neste servidor (incident_notify_critical/atencao)
  3. incidente silenciado individualmente (Incident.silenced_until no futuro)
  4. janela de silêncio noturno — só severidade "atencao"; crítico
     sempre notifica, a qualquer hora (comparação em UTC — sem timezone
     por servidor no schema hoje, limitação conhecida e documentada).
"""
import hashlib
import hmac
import json
import logging
import urllib.request
from datetime import datetime, time as dt_time
from typing import Optional

from .alerts import _send_raw_email
from .config import settings
from .database import AlertHistory, AlertSettings, Incident, Server, SessionLocal, get_alert_settings

logger = logging.getLogger(__name__)


def _in_night_window(cfg: AlertSettings, now: Optional[datetime] = None) -> bool:
    if not cfg.night_silence_start or not cfg.night_silence_end:
        return False
    now = now or datetime.utcnow()
    try:
        start_h, start_m = (int(x) for x in cfg.night_silence_start.split(":"))
        end_h, end_m = (int(x) for x in cfg.night_silence_end.split(":"))
    except (ValueError, AttributeError):
        return False
    start = dt_time(start_h, start_m)
    end = dt_time(end_h, end_m)
    now_t = now.time()
    if start <= end:
        return start <= now_t < end
    # Janela cruza a meia-noite (ex.: 22:00 → 07:00)
    return now_t >= start or now_t < end


def _should_notify(incident: Incident, event_type: str, cfg: AlertSettings) -> Optional[str]:
    """Retorna None se deve notificar, ou o motivo do silenciamento."""
    if event_type not in ("opened", "escalated", "resolved"):
        return f"evento '{event_type}' não gera notificação (só opened/escalated/resolved)"
    if incident.type in (cfg.muted_incident_types or []):
        return f"tipo '{incident.type}' silenciado neste servidor"
    if incident.severity == "critico" and not cfg.incident_notify_critical:
        return "notificação de severidade crítica desligada neste servidor"
    if incident.severity == "atencao" and not cfg.incident_notify_atencao:
        return "notificação de severidade atenção desligada neste servidor"
    if incident.silenced_until and datetime.utcnow() < incident.silenced_until:
        return f"incidente silenciado até {incident.silenced_until.isoformat()}Z"
    if incident.severity == "atencao" and _in_night_window(cfg):
        return "janela de silêncio noturno (severidade atenção)"
    return None


_EVENT_LABEL = {"opened": "Novo incidente", "escalated": "Incidente agravado", "resolved": "Incidente resolvido"}
_SEVERITY_LABEL = {"critico": "CRÍTICO", "atencao": "ATENÇÃO"}


def _incident_url(incident: Incident) -> str:
    return f"{settings.app_url}/incidents/{incident.display_id}"


def _build_text(incident: Incident, event_type: str, server_name: str) -> str:
    since = incident.first_seen.strftime("%d/%m/%Y %H:%M") if incident.first_seen else "?"
    cause = incident.metrics.get("cause") if incident.metrics else None
    lines = [
        f"{_EVENT_LABEL.get(event_type, event_type)} — {_SEVERITY_LABEL.get(incident.severity, incident.severity)}",
        f"Servidor: {server_name}",
        f"Tipo: {incident.type}",
        f"Entidade: {incident.entity}",
        f"Desde: {since}",
    ]
    if incident.suggested_fix and incident.suggested_fix.get("description"):
        lines.append(f"Causa provável: {incident.suggested_fix['description'][:200]}")
    lines.append(_incident_url(incident))
    return "\n".join(lines)


def _incident_email_html(incident: Incident, event_type: str, server_name: str) -> str:
    color = "#A32D2D" if incident.severity == "critico" else "#854F0B"
    label = _EVENT_LABEL.get(event_type, event_type)
    since = incident.first_seen.strftime("%d/%m/%Y %H:%M UTC") if incident.first_seen else "?"
    desc = (incident.suggested_fix or {}).get("description", "")
    url = _incident_url(incident)
    return f"""
<!DOCTYPE html><html><body style="font-family:sans-serif;background:#f8f8f6;margin:0;padding:24px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;border:0.5px solid #d3d1c7;overflow:hidden">
  <div style="background:{color};padding:20px 28px">
    <h1 style="color:#fff;margin:0;font-size:18px">Mail IQ — {label}</h1>
  </div>
  <div style="padding:24px 28px">
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <tr><td style="padding:8px 0;color:#888;border-bottom:0.5px solid #eee">Servidor</td>
          <td style="padding:8px 0;border-bottom:0.5px solid #eee;font-weight:600">{server_name}</td></tr>
      <tr><td style="padding:8px 0;color:#888;border-bottom:0.5px solid #eee">Tipo</td>
          <td style="padding:8px 0;border-bottom:0.5px solid #eee">{incident.type}</td></tr>
      <tr><td style="padding:8px 0;color:#888;border-bottom:0.5px solid #eee">Entidade</td>
          <td style="padding:8px 0;border-bottom:0.5px solid #eee;font-weight:600">{incident.entity}</td></tr>
      <tr><td style="padding:8px 0;color:#888">Desde</td><td style="padding:8px 0">{since}</td></tr>
    </table>
    <p style="margin:16px 0 0;color:#2c2c2a;font-size:13px">{desc}</p>
    <p style="margin:20px 0 0"><a href="{url}" style="color:{color};font-weight:600">Abrir {incident.display_id} →</a></p>
  </div>
</div>
</body></html>"""


def _send_incident_telegram(cfg: AlertSettings, incident: Incident, event_type: str, server_name: str) -> None:
    icon = "🔴" if incident.severity == "critico" else "🟡"
    # Escapa HTML básico do texto (entidade/descrição podem conter '<'/'>')
    safe = _build_text(incident, event_type, server_name)
    for ch, esc in (("&", "&amp;"), ("<", "&lt;"), (">", "&gt;")):
        safe = safe.replace(ch, esc)
    payload = json.dumps({"chat_id": cfg.telegram_chat_id, "text": f"{icon} {safe}", "parse_mode": "HTML"}).encode()
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{cfg.telegram_bot_token}/sendMessage",
        data=payload, headers={"Content-Type": "application/json"},
    )
    urllib.request.urlopen(req, timeout=10)


def _send_incident_webhook(cfg: AlertSettings, incident: Incident, event_type: str, server_name: str) -> None:
    payload = {
        "event": event_type,
        "incident_id": incident.display_id,
        "type": incident.type,
        "severity": incident.severity,
        "status": incident.status,
        "server_id": incident.server_id,
        "server_name": server_name,
        "entity": incident.entity,
        "first_seen": incident.first_seen.isoformat() + "Z" if incident.first_seen else None,
        "url": _incident_url(incident),
        "timestamp": datetime.utcnow().isoformat() + "Z",
    }
    body = json.dumps(payload).encode()
    headers = {"Content-Type": "application/json"}
    if cfg.webhook_secret:
        sig = hmac.new(cfg.webhook_secret.encode(), body, hashlib.sha256).hexdigest()
        headers["X-EximMonitor-Signature"] = f"sha256={sig}"
    req = urllib.request.Request(cfg.webhook_url, data=body, headers=headers)
    urllib.request.urlopen(req, timeout=10)


def _record(channel: str, incident: Incident, event_type: str, success: bool, error_msg: Optional[str] = None) -> None:
    try:
        db = SessionLocal()
        try:
            db.add(AlertHistory(
                server_id=incident.server_id, channel=channel, severity=incident.severity,
                problem=f"{incident.type}:{event_type}:{incident.display_id}",
                queue_total=0, success=success, error_msg=error_msg,
            ))
            db.commit()
        finally:
            db.close()
    except Exception as exc:
        logger.warning("Não foi possível registrar histórico de notificação de incidente: %s", exc)


def notify_incident_event(incident: Incident, event_type: str) -> None:
    """
    Ponto de entrada síncrono, chamado por incident_engine.py logo após
    persistir a transição de estado. Síncrono (não asyncio.to_thread)
    porque incident_engine roda dentro de asyncio.to_thread já (mesma
    thread separada da coleta) — ver collector.py.
    """
    db = SessionLocal()
    try:
        cfg = get_alert_settings(db, server_id=incident.server_id)
        server = db.get(Server, incident.server_id)
        server_name = server.name if server else f"servidor {incident.server_id}"

        reason = _should_notify(incident, event_type, cfg)
        if reason:
            logger.debug("Notificação de %s (%s) suprimida: %s", incident.display_id, event_type, reason)
            return

        if cfg.email_enabled and cfg.email_to and (cfg.smtp_password or cfg.resend_api_key):
            try:
                _send_raw_email(
                    cfg, f"[Mail IQ] {_EVENT_LABEL.get(event_type, event_type)} — {incident.display_id}",
                    _incident_email_html(incident, event_type, server_name),
                )
                _record("email", incident, event_type, True)
            except Exception as exc:
                logger.error("Falha ao enviar e-mail de incidente: %s", exc)
                _record("email", incident, event_type, False, str(exc)[:500])

        if cfg.telegram_enabled and cfg.telegram_bot_token and cfg.telegram_chat_id:
            try:
                _send_incident_telegram(cfg, incident, event_type, server_name)
                _record("telegram", incident, event_type, True)
            except Exception as exc:
                logger.error("Falha ao enviar Telegram de incidente: %s", exc)
                _record("telegram", incident, event_type, False, str(exc)[:500])

        if cfg.webhook_url:
            try:
                _send_incident_webhook(cfg, incident, event_type, server_name)
                _record("webhook", incident, event_type, True)
            except Exception as exc:
                logger.error("Falha ao enviar webhook de incidente: %s", exc)
                _record("webhook", incident, event_type, False, str(exc)[:500])
    finally:
        db.close()
