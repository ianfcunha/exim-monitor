"""
Sessão 3, Tarefa 3 — relatório mensal por servidor e por frota.
Incidentes por tipo, MTTR, mensagens recuperadas da quarentena, tempo
total em blocklist e evolução (semanal) da taxa de entrega — cobrindo o
mês calendário anterior completo. Enviado por e-mail automaticamente
assim que o loop percebe que o mês virou (não depende de rodar
exatamente no dia 1 — sobrevive a um restart do backend nesse dia).

Mesmo padrão de reports.py (relatório semanal): server_id preenchido em
AlertSettings envia o relatório DAQUELE servidor; o registro global
(server_id nulo) envia o relatório DA FROTA inteira (todos os
servidores habilitados, não só os de um "owner" — este produto assume
um dono de hosting por instalação self-hosted, mesma premissa que o
resto do app já faz).
"""
import asyncio
import logging
import re
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from .alerts import _send_raw_email
from .database import ActionHistory, AlertSettings, Incident, Server, SessionLocal, Snapshot, get_alert_settings

logger = logging.getLogger(__name__)

_RESTORED_COUNT_RE = re.compile(r"^(\d+)\s+mensagem")


def _previous_month_period(now: Optional[datetime] = None) -> tuple[datetime, datetime]:
    now = now or datetime.utcnow()
    first_of_this_month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    last_of_prev_month = first_of_this_month - timedelta(seconds=1)
    first_of_prev_month = last_of_prev_month.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    return first_of_prev_month, first_of_this_month


def _incidents_by_type(db, server_ids: List[int], start: datetime, end: datetime) -> Dict[str, int]:
    rows = (
        db.query(Incident)
        .filter(Incident.server_id.in_(server_ids), Incident.first_seen >= start, Incident.first_seen < end)
        .all()
    )
    counts: Dict[str, int] = {}
    for i in rows:
        counts[i.type] = counts.get(i.type, 0) + 1
    return counts


def _mttr_seconds(db, server_ids: List[int], start: datetime, end: datetime) -> Optional[float]:
    """Tempo médio até resolver — só considera incidentes efetivamente
    RESOLVIDOS dentro do período (resolved_at no período), não os que
    ainda estão abertos."""
    rows = (
        db.query(Incident)
        .filter(Incident.server_id.in_(server_ids), Incident.resolved_at.isnot(None),
                Incident.resolved_at >= start, Incident.resolved_at < end)
        .all()
    )
    if not rows:
        return None
    total = sum((i.resolved_at - i.first_seen).total_seconds() for i in rows)
    return round(total / len(rows))


def _messages_recovered_from_quarantine(db, server_ids: List[int], start: datetime, end: datetime) -> int:
    rows = (
        db.query(ActionHistory)
        .filter(ActionHistory.server_id.in_(server_ids), ActionHistory.action == "restore-quarantine",
                ActionHistory.success.is_(True), ActionHistory.executed_at >= start, ActionHistory.executed_at < end)
        .all()
    )
    total = 0
    for a in rows:
        m = _RESTORED_COUNT_RE.match(a.message or "")
        if m:
            total += int(m.group(1))
    return total


def _total_time_in_blocklist_seconds(db, server_ids: List[int], start: datetime, end: datetime, now: datetime) -> float:
    """Soma a duração (aberto→resolvido, ou aberto→agora se ainda ativo)
    de todo incidente `reputation` cuja causa é blocklist (metrics tem
    `blocklists_listed`) e que começou dentro do período. Não faz
    interseção fracionária com a janela — um incidente que começou no
    período conta a duração inteira, mesmo que termine depois."""
    rows = (
        db.query(Incident)
        .filter(Incident.server_id.in_(server_ids), Incident.type == "reputation",
                Incident.first_seen >= start, Incident.first_seen < end)
        .all()
    )
    total = 0.0
    for i in rows:
        if not (i.metrics or {}).get("blocklists_listed"):
            continue
        end_point = i.resolved_at or now
        total += (end_point - i.first_seen).total_seconds()
    return total


def _delivery_rate_evolution(db, server_ids: List[int], start: datetime, end: datetime) -> List[Dict[str, Any]]:
    """Buckets semanais (até 5, cobrindo o mês) com a taxa média de
    entrega — mesma fórmula de reports.py/incident_impact.py (média das
    taxas por snapshot, não soma bruta — cada Snapshot já é uma janela
    própria, não um delta)."""
    buckets = []
    cursor = start
    while cursor < end:
        week_end = min(cursor + timedelta(days=7), end)
        snaps = (
            db.query(Snapshot)
            .filter(Snapshot.server_id.in_(server_ids), Snapshot.mode == "full",
                    Snapshot.timestamp >= cursor, Snapshot.timestamp < week_end)
            .all()
        )
        rates = []
        for s in snaps:
            attempts = (s.delivered or 0) + (s.rejected or 0)
            if attempts > 0:
                rates.append(s.delivered / attempts)
        buckets.append({
            "week_start": cursor.strftime("%Y-%m-%d"),
            "delivery_rate": round(sum(rates) / len(rates) * 100, 1) if rates else None,
        })
        cursor = week_end
    return buckets


def _build_report(db, server_ids: List[int], start: datetime, end: datetime) -> Dict[str, Any]:
    now = datetime.utcnow()
    return {
        "period_start": start,
        "period_end": end,
        "incidents_by_type": _incidents_by_type(db, server_ids, start, end),
        "mttr_seconds": _mttr_seconds(db, server_ids, start, end),
        "messages_recovered_from_quarantine": _messages_recovered_from_quarantine(db, server_ids, start, end),
        "total_time_in_blocklist_seconds": _total_time_in_blocklist_seconds(db, server_ids, start, end, now),
        "delivery_rate_evolution": _delivery_rate_evolution(db, server_ids, start, end),
    }


def build_monthly_report(db, server_id: int) -> Dict[str, Any]:
    start, end = _previous_month_period()
    return _build_report(db, [server_id], start, end)


def build_fleet_monthly_report(db) -> Dict[str, Any]:
    start, end = _previous_month_period()
    servers = db.query(Server).filter(Server.is_enabled == True).all()
    fleet = _build_report(db, [s.id for s in servers], start, end)
    fleet["per_server"] = [
        {"server_id": s.id, "server_name": s.name, **_build_report(db, [s.id], start, end)}
        for s in servers
    ]
    return fleet


# ── E-mail ───────────────────────────────────────────────────────────────

def _fmt_duration(seconds: Optional[float]) -> str:
    if not seconds:
        return "—"
    h = int(seconds // 3600)
    return f"{h}h" if h < 48 else f"{round(h / 24, 1)} dias"


def _report_email_html(title: str, data: Dict[str, Any]) -> str:
    fmt = lambda dt: dt.strftime("%m/%Y")
    type_labels = {"auth_abuse": "Conta comprometida", "reputation": "Reputação em risco",
                   "queue_stuck": "Fila travada", "dest_deferral": "Rate limit de destino"}

    types_html = "".join(
        f'<tr><td style="padding:6px 0;color:#2c2c2a">{type_labels.get(t, t)}</td>'
        f'<td style="padding:6px 0;text-align:right;color:#888">{n}</td></tr>'
        for t, n in sorted(data["incidents_by_type"].items(), key=lambda kv: -kv[1])
    ) or '<tr><td style="padding:6px 0;color:#888">Nenhum incidente no período.</td></tr>'

    def _rate_label(b):
        return f'{b["delivery_rate"]}%' if b["delivery_rate"] is not None else "sem dados"

    evolution_html = "".join(
        f'<tr><td style="padding:6px 0;color:#2c2c2a">Semana de {b["week_start"]}</td>'
        f'<td style="padding:6px 0;text-align:right;color:#888">{_rate_label(b)}</td></tr>'
        for b in data["delivery_rate_evolution"]
    )

    per_server_html = ""
    if "per_server" in data:
        rows = "".join(
            f'<tr><td style="padding:6px 0;color:#2c2c2a">{s["server_name"]}</td>'
            f'<td style="padding:6px 0;text-align:right;color:#888">{sum(s["incidents_by_type"].values())} incidente(s)</td>'
            f'<td style="padding:6px 0;text-align:right;color:#888">MTTR {_fmt_duration(s["mttr_seconds"])}</td></tr>'
            for s in data["per_server"]
        ) or '<tr><td style="padding:6px 0;color:#888">Nenhum servidor habilitado.</td></tr>'
        per_server_html = f"""
    <p style="margin:20px 0 6px;color:#2c2c2a;font-size:13px;font-weight:700">Por servidor</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px">{rows}</table>"""

    return f"""
<!DOCTYPE html><html><body style="font-family:sans-serif;background:#f8f8f6;margin:0;padding:24px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;
            border:0.5px solid #d3d1c7;overflow:hidden">
  <div style="background:#185FA5;padding:20px 28px">
    <h1 style="color:#fff;margin:0;font-size:18px">Relatório mensal — {title}</h1>
    <p style="color:#DCEBFA;margin:4px 0 0;font-size:12px">Referente a {fmt(data['period_start'])}</p>
  </div>
  <div style="padding:24px 28px">
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
      <tr><td style="padding:8px 0;color:#888;border-bottom:0.5px solid #eee">MTTR (tempo médio até resolver)</td>
          <td style="padding:8px 0;border-bottom:0.5px solid #eee;font-weight:600;text-align:right">{_fmt_duration(data['mttr_seconds'])}</td></tr>
      <tr><td style="padding:8px 0;color:#888;border-bottom:0.5px solid #eee">Mensagens recuperadas da quarentena</td>
          <td style="padding:8px 0;border-bottom:0.5px solid #eee;font-weight:600;text-align:right">{data['messages_recovered_from_quarantine']}</td></tr>
      <tr><td style="padding:8px 0;color:#888">Tempo total em blocklist</td>
          <td style="padding:8px 0;font-weight:600;text-align:right">{_fmt_duration(data['total_time_in_blocklist_seconds'])}</td></tr>
    </table>

    <p style="margin:0 0 6px;color:#2c2c2a;font-size:13px;font-weight:700">Incidentes por tipo</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px">{types_html}</table>

    <p style="margin:0 0 6px;color:#2c2c2a;font-size:13px;font-weight:700">Evolução da taxa de entrega</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px">{evolution_html}</table>
    {per_server_html}

    <p style="margin:20px 0 0;color:#888;font-size:12px">Abra a Triagem para o histórico completo.</p>
  </div>
  <div style="background:#f8f8f6;padding:12px 28px;font-size:11px;color:#aaa">
    Mail IQ &mdash; enviado automaticamente em {datetime.utcnow().strftime("%d/%m/%Y %H:%M")} UTC
  </div>
</div>
</body></html>"""


async def _send(cfg: AlertSettings, title: str, data: Dict[str, Any]) -> bool:
    if not cfg.email_to or not (cfg.resend_api_key or cfg.smtp_password):
        logger.warning("Relatório mensal habilitado mas e-mail não configurado (%s)", title)
        return False
    html = _report_email_html(title, data)
    subject = f"[Mail IQ] Relatório mensal — {title}"
    await asyncio.to_thread(_send_raw_email, cfg, subject, html)
    return True


async def send_monthly_report(server_id: int, server_name: str, mark_sent: bool = True) -> bool:
    db = SessionLocal()
    try:
        cfg = get_alert_settings(db, server_id=server_id)
        if not cfg.monthly_report_enabled:
            return False
        data = build_monthly_report(db, server_id)
        sent = await _send(cfg, server_name, data)
        if sent and mark_sent:
            cfg.monthly_report_last_sent_at = datetime.utcnow()
            db.commit()
        return sent
    except Exception:
        logger.exception("Falha ao enviar relatório mensal (server_id=%s)", server_id)
        return False
    finally:
        db.close()


async def send_fleet_monthly_report(mark_sent: bool = True) -> bool:
    db = SessionLocal()
    try:
        cfg = get_alert_settings(db, server_id=None)
        if not cfg.monthly_report_enabled:
            return False
        data = build_fleet_monthly_report(db)
        sent = await _send(cfg, "toda a frota", data)
        if sent and mark_sent:
            cfg.monthly_report_last_sent_at = datetime.utcnow()
            db.commit()
        return sent
    except Exception:
        logger.exception("Falha ao enviar relatório mensal da frota")
        return False
    finally:
        db.close()


async def monthly_report_loop() -> None:
    """Checa 1x por dia se o mês virou desde o último envio — não
    depende de rodar exatamente no dia 1 (sobrevive a um restart nesse
    dia sem perder o envio do mês)."""
    await asyncio.sleep(200)  # espera o coletor estabilizar no boot
    while True:
        try:
            first_of_this_month = datetime.utcnow().replace(day=1, hour=0, minute=0, second=0, microsecond=0)

            db = SessionLocal()
            try:
                servers = db.query(Server).filter(Server.is_enabled == True).all()
                fleet_cfg = get_alert_settings(db, server_id=None)
                fleet_due = fleet_cfg.monthly_report_enabled and (
                    fleet_cfg.monthly_report_last_sent_at is None
                    or fleet_cfg.monthly_report_last_sent_at < first_of_this_month
                )
            finally:
                db.close()

            if fleet_due:
                await send_fleet_monthly_report()

            for server in servers:
                db2 = SessionLocal()
                try:
                    cfg = get_alert_settings(db2, server_id=server.id)
                    due = cfg.monthly_report_enabled and (
                        cfg.monthly_report_last_sent_at is None
                        or cfg.monthly_report_last_sent_at < first_of_this_month
                    )
                finally:
                    db2.close()
                if due:
                    await send_monthly_report(server.id, server.name)
        except Exception:
            logger.exception("Erro no loop de relatórios mensais")
        await asyncio.sleep(24 * 3600)
