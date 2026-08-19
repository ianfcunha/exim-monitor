"""
Relatório semanal por servidor — resumo de saúde, deliverability, principais
diagnósticos, ações executadas e alertas disparados no período. Reaproveita
o transporte de e-mail já existente em alerts.py (Resend/SMTP) — não recria
nada de envio aqui, só monta o conteúdo e decide quando disparar.

Job periódico no mesmo espírito de collector.py/background_collector, mas
com cadência semanal em vez de segundos: weekly_report_loop() roda 1x por
dia e só envia para servidores com weekly_report_enabled=True cujo último
envio (persistido em AlertSettings.weekly_report_last_sent_at — não em
memória, para sobreviver a um restart do backend) já passou de 7 dias.
"""
import asyncio
import logging
from datetime import datetime, timedelta
from typing import Optional

from .alerts import _send_raw_email
from .database import (
    ActionHistory, AlertHistory, Server, SessionLocal, Snapshot,
    get_alert_settings,
)

logger = logging.getLogger(__name__)

REPORT_PERIOD_DAYS = 7


def build_weekly_report(db, server_id: Optional[int]) -> dict:
    """
    Monta o resumo do período a partir de Snapshot/ActionHistory/AlertHistory.

    Cada Snapshot é uma janela (HOURS_WINDOW do script, não um delta desde o
    snapshot anterior) — somar delivered/rejected/deferred de todos os
    snapshots do período re-contaria as mesmas linhas de log várias vezes.
    Por isso a taxa de entrega usa a MÉDIA da taxa por snapshot (modo full),
    não a soma bruta; "principais diagnósticos" usa frequência (em quantos
    snapshots aquele problema apareceu), que continua sendo um sinal válido
    de persistência mesmo com janelas sobrepostas.
    """
    period_end   = datetime.utcnow()
    period_start = period_end - timedelta(days=REPORT_PERIOD_DAYS)

    full_snaps = (
        db.query(Snapshot)
        .filter(
            Snapshot.server_id == server_id,
            Snapshot.mode == "full",
            Snapshot.timestamp >= period_start,
        )
        .order_by(Snapshot.timestamp.asc())
        .all()
    )

    rates = []
    severity_counts: dict = {}
    problem_counts: dict = {}
    for s in full_snaps:
        attempts = (s.delivered or 0) + (s.rejected or 0)
        if attempts > 0:
            rates.append(s.delivered / attempts)
        severity_counts[s.severity] = severity_counts.get(s.severity, 0) + 1
        if s.problem and s.problem != "NORMAL":
            problem_counts[s.problem] = problem_counts.get(s.problem, 0) + 1

    delivery_rate = round(sum(rates) / len(rates) * 100, 1) if rates else None
    healthy_pct = (
        round(severity_counts.get("OK", 0) / len(full_snaps) * 100, 1)
        if full_snaps else None
    )
    top_problems = sorted(problem_counts.items(), key=lambda kv: -kv[1])[:5]
    latest_severity = full_snaps[-1].severity if full_snaps else "OK"

    actions = (
        db.query(ActionHistory)
        .filter(ActionHistory.server_id == server_id, ActionHistory.executed_at >= period_start)
        .order_by(ActionHistory.executed_at.desc())
        .all()
    )

    alerts = (
        db.query(AlertHistory)
        .filter(AlertHistory.server_id == server_id, AlertHistory.sent_at >= period_start)
        .order_by(AlertHistory.sent_at.desc())
        .all()
    )

    return {
        "period_start":     period_start,
        "period_end":       period_end,
        "snapshot_count":   len(full_snaps),
        "latest_severity":  latest_severity,
        "healthy_pct":      healthy_pct,
        "delivery_rate":    delivery_rate,
        "top_problems":     top_problems,
        "actions":          actions,
        "alerts":           alerts,
    }


def _report_email_html(server_name: str, data: dict) -> str:
    fmt = lambda dt: dt.strftime("%d/%m/%Y")
    healthy = f"{data['healthy_pct']}%" if data["healthy_pct"] is not None else "sem dados"
    delivery = f"{data['delivery_rate']}%" if data["delivery_rate"] is not None else "sem dados"

    problems_html = "".join(
        f'<tr><td style="padding:6px 0;color:#2c2c2a">{p}</td>'
        f'<td style="padding:6px 0;text-align:right;color:#888">{n}x</td></tr>'
        for p, n in data["top_problems"]
    ) or '<tr><td style="padding:6px 0;color:#888">Nenhum problema recorrente no período.</td></tr>'

    actions_html = "".join(
        f'<tr><td style="padding:6px 0;color:#2c2c2a">{a.action}'
        f'{" (" + a.param + ")" if a.param else ""}</td>'
        f'<td style="padding:6px 0;text-align:right;color:{"#2E7D32" if a.success else "#A32D2D"}">'
        f'{"OK" if a.success else "falhou"}</td></tr>'
        for a in data["actions"][:10]
    ) or '<tr><td style="padding:6px 0;color:#888">Nenhuma ação executada no período.</td></tr>'

    alerts_html = "".join(
        f'<tr><td style="padding:6px 0;color:#2c2c2a">{a.severity} — {a.problem}</td>'
        f'<td style="padding:6px 0;text-align:right;color:#888">{a.channel}</td></tr>'
        for a in data["alerts"][:10]
    ) or '<tr><td style="padding:6px 0;color:#888">Nenhum alerta disparado no período.</td></tr>'

    return f"""
<!DOCTYPE html><html><body style="font-family:sans-serif;background:#f8f8f6;margin:0;padding:24px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;
            border:0.5px solid #d3d1c7;overflow:hidden">
  <div style="background:#185FA5;padding:20px 28px">
    <h1 style="color:#fff;margin:0;font-size:18px">Relatório semanal — {server_name}</h1>
    <p style="color:#DCEBFA;margin:4px 0 0;font-size:12px">
      {fmt(data['period_start'])} a {fmt(data['period_end'])}
    </p>
  </div>
  <div style="padding:24px 28px">
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:20px">
      <tr>
        <td style="padding:8px 0;color:#888;border-bottom:0.5px solid #eee">Saúde do servidor</td>
        <td style="padding:8px 0;border-bottom:0.5px solid #eee;font-weight:600;text-align:right">
          {healthy} dos checks OK
        </td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#888;border-bottom:0.5px solid #eee">Taxa média de entrega</td>
        <td style="padding:8px 0;border-bottom:0.5px solid #eee;font-weight:600;text-align:right">{delivery}</td>
      </tr>
      <tr>
        <td style="padding:8px 0;color:#888">Severidade atual</td>
        <td style="padding:8px 0;font-weight:600;text-align:right">{data['latest_severity']}</td>
      </tr>
    </table>

    <p style="margin:0 0 6px;color:#2c2c2a;font-size:13px;font-weight:700">Principais diagnósticos</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px">{problems_html}</table>

    <p style="margin:0 0 6px;color:#2c2c2a;font-size:13px;font-weight:700">Ações executadas</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px">{actions_html}</table>

    <p style="margin:0 0 6px;color:#2c2c2a;font-size:13px;font-weight:700">Alertas disparados</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px">{alerts_html}</table>

    <p style="margin:20px 0 0;color:#888;font-size:12px">
      Abra o dashboard para o histórico completo.
    </p>
  </div>
  <div style="background:#f8f8f6;padding:12px 28px;font-size:11px;color:#aaa">
    EXIM Monitor &mdash; enviado automaticamente em {datetime.utcnow().strftime("%d/%m/%Y %H:%M")} UTC
  </div>
</div>
</body></html>"""


async def send_weekly_report(server_id: Optional[int], server_name: str,
                             mark_sent: bool = True) -> bool:
    """
    Monta e envia o relatório semanal por e-mail para um servidor.
    Retorna True se enviado, False se opt-in desligado ou e-mail não
    configurado. mark_sent=False permite disparo manual de teste sem
    afetar o agendamento (weekly_report_last_sent_at).
    """
    db = SessionLocal()
    try:
        cfg = get_alert_settings(db, server_id=server_id)
        if not cfg.weekly_report_enabled:
            return False
        if not cfg.email_to or not (cfg.resend_api_key or cfg.smtp_password):
            logger.warning("Relatório semanal habilitado mas e-mail não configurado (server_id=%s)", server_id)
            return False

        data = build_weekly_report(db, server_id)
        html = _report_email_html(server_name, data)
        subject = f"[EXIM Monitor] Relatório semanal — {server_name}"
        await asyncio.to_thread(_send_raw_email, cfg, subject, html)

        if mark_sent:
            cfg.weekly_report_last_sent_at = datetime.utcnow()
            db.commit()

        logger.info("Relatório semanal enviado (server_id=%s)", server_id)
        return True
    except Exception:
        logger.exception("Falha ao enviar relatório semanal (server_id=%s)", server_id)
        return False
    finally:
        db.close()


async def weekly_report_loop() -> None:
    """Checa 1x por dia quais servidores estão com o relatório vencido."""
    await asyncio.sleep(180)  # espera o coletor estabilizar no boot
    while True:
        try:
            db = SessionLocal()
            try:
                servers = db.query(Server).filter(Server.is_enabled == True).all()
            finally:
                db.close()

            cutoff = datetime.utcnow() - timedelta(days=REPORT_PERIOD_DAYS)
            for server in servers:
                db2 = SessionLocal()
                try:
                    cfg = get_alert_settings(db2, server_id=server.id)
                    due = cfg.weekly_report_enabled and (
                        cfg.weekly_report_last_sent_at is None
                        or cfg.weekly_report_last_sent_at <= cutoff
                    )
                finally:
                    db2.close()
                if due:
                    await send_weekly_report(server.id, server.name)
        except Exception:
            logger.exception("Erro no loop de relatórios semanais")
        await asyncio.sleep(24 * 3600)
