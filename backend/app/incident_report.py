"""
Sessão 3, Tarefa 2 — relatório de incidente exportável. "O documento que
o dono do host encaminha ao cliente dele — e é o artefato que fecha a
conversão do piloto. Trate-o como um produto, não como um relatório"
(instrução explícita do usuário) — por isso HTML autocontido (CSS
inline, sem dependência externa nenhuma: quem recebe o arquivo consegue
abrir offline), linguagem sem jargão nas seções narrativas, e CSS de
impressão dedicado (a exportação em PDF "barata" é o Ctrl+P do
navegador sobre esta mesma página, não um gerador de PDF no backend).

render_incident_report_html() é puro — recebe o Incident já carregado
(com .server e .events, ver get_incident em routers/incidents.py) e a
lista de ActionHistory já filtrada por incident_id — não faz query
nenhuma sozinho, pra poder ser testado sem banco.
"""
from datetime import datetime
from typing import Any, Dict, List, Optional

TYPE_LABELS = {
    "auth_abuse": "Conta comprometida", "reputation": "Reputação em risco",
    "queue_stuck": "Fila travada", "dest_deferral": "Rate limit de destino",
}
STATUS_LABELS = {
    "aberto": "Aberto", "em_observacao": "Em observação", "mitigado": "Mitigado", "resolvido": "Resolvido",
}
ACTION_LABELS = {
    "clean-frozen": "Mensagens congeladas enviadas para quarentena",
    "clean-bounces": "Mensagens de retorno (bounce) enviadas para quarentena",
    "clean-sender": "Mensagens do remetente enviadas para quarentena",
    "clean-auth": "Mensagens da conta comprometida enviadas para quarentena",
    "block-ip": "IP de origem bloqueado no firewall",
    "block-sender": "Remetente bloqueado",
    "retry-queue": "Reprocessamento forçado da fila",
    "check-deliverability": "Checagem de reputação/entrega",
}


def _fmt_dt(dt: Optional[datetime]) -> str:
    return dt.strftime("%d/%m/%Y às %H:%M") if dt else "—"


def _fmt_duration(seconds: Optional[float]) -> str:
    if seconds is None:
        return "—"
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    if h == 0:
        return f"{m} minuto{'s' if m != 1 else ''}"
    return f"{h}h{f'{m:02d}min' if m else ''}"


# ── Narrativa em linguagem simples ──────────────────────────────────────────
# Cada tipo de incidente tem uma causa e um contrafactual próprios — texto
# fixo por tipo (não gerado a partir de metrics cru), justamente pra
# garantir que fique em português claro mesmo quando os números por trás
# são técnicos (distinct_ips, blocklists_listed etc, já mostrados à parte
# na seção de métricas/evidência).
_CAUSE_TEXT = {
    "auth_abuse": lambda inc: (
        f"Uma credencial de e-mail deste servidor ({inc.entity}) foi usada para autenticar "
        f"a partir de múltiplos endereços de rede diferentes num curto espaço de tempo, ou "
        f"com um volume de envio muito acima do normal dessa conta — o padrão típico de uma "
        f"senha vazada sendo usada para disparar spam através do servidor."
    ),
    "reputation": lambda inc: (
        f"O IP de saída do servidor foi listado em uma ou mais blocklists usadas por "
        f"provedores de e-mail para filtrar spam."
        if (inc.metrics or {}).get("blocklists_listed") else
        f"O domínio {inc.entity.split(':', 1)[-1] if ':' in inc.entity else ''} está sem "
        f"registros de autenticação (SPF, DKIM e/ou DMARC) apesar de enviar volume real de "
        f"e-mail — provedores grandes usam a ausência desses registros como sinal de spam."
        if (inc.metrics or {}).get("missing") else
        f"O certificado TLS usado pelo servidor está expirado ou perto de expirar."
    ),
    "queue_stuck": lambda inc: (
        f"A fila de envio parou de esvaziar e cresceu de forma consistente por vários ciclos "
        f"seguidos, concentrada em {inc.entity.split(':', 1)[-1] if ':' in inc.entity else 'um ponto específico'} — "
        f"sinal de que mensagens estão se acumulando em vez de serem entregues."
    ),
    "dest_deferral": lambda inc: (
        f"Um provedor de destino específico ({inc.entity.split(':', 1)[-1] if ':' in inc.entity else inc.entity}) "
        f"está temporariamente limitando a taxa de recebimento de mensagens deste servidor — "
        f"comportamento normal de controle de tráfego do provedor, não um problema deste servidor."
    ),
}

_COUNTERFACTUAL_TEXT = {
    "auth_abuse": (
        "Sem intervenção, a conta comprometida continuaria sendo usada para disparar spam "
        "através deste servidor. Isso costuma terminar com o IP de saída entrando em "
        "blocklists — a partir daí, a entrega cai não só para essa conta, mas para "
        "todos os outros clientes que dividem o mesmo servidor."
    ),
    "reputation": (
        "Sem correção, provedores como Gmail e Outlook continuariam rejeitando ou "
        "direcionando para spam uma fração crescente das mensagens enviadas por este "
        "servidor — o problema tende a piorar com o tempo, não a se resolver sozinho."
    ),
    "queue_stuck": (
        "Sem intervenção, a fila continuaria crescendo — mensagens legítimas ficariam "
        "cada vez mais atrasadas, e o acúmulo aumenta o risco de o servidor ser visto "
        "como fonte de tráfego anômalo pelos provedores de destino."
    ),
    "dest_deferral": (
        "Sem ação nenhuma (o que é o esperado aqui — ver observação acima), o próprio "
        "provedor de destino libera o tráfego gradualmente; forçar reenvio antes disso só "
        "adiciona carga desnecessária à fila."
    ),
}


def _cause_text(incident) -> str:
    fn = _CAUSE_TEXT.get(incident.type)
    return fn(incident) if fn else "Causa não documentada para este tipo de incidente."


def _counterfactual_text(incident) -> str:
    return _COUNTERFACTUAL_TEXT.get(incident.type, "Impacto de não agir não documentado para este tipo de incidente.")


def _actions_rows_html(actions: List[Any]) -> str:
    if not actions:
        return '<tr><td colspan="4" class="muted">Nenhuma ação executada pelo painel neste incidente — ver observação acima.</td></tr>'
    rows = []
    for a in actions:
        label = ACTION_LABELS.get(a.action, a.action)
        status = '<span class="ok">concluída</span>' if a.success else '<span class="bad">falhou</span>'
        # ActionHistory.message pode conter o before_snapshot anexado
        # (ver routers/actions.py) separado por um marcador — só a
        # primeira linha (o resultado em si) interessa aqui.
        first_line = (a.message or "").split("\n\n---", 1)[0].strip()
        detail = f'<br><span class="muted">{first_line}</span>' if first_line else ""
        rows.append(
            f'<tr><td>{_fmt_dt(a.executed_at)}</td>'
            f'<td>{label}{f" ({a.param})" if a.param else ""}{detail}</td>'
            f'<td>{a.actor}</td><td>{status}</td></tr>'
        )
    return "".join(rows)


def _evidence_html(incident) -> str:
    lines = (incident.evidence or {}).get("lines") or []
    if not lines:
        return '<p class="muted">Nenhuma linha de log foi capturada como evidência para este incidente.</p>'
    escaped = "\n".join(
        line.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;") for line in lines
    )
    return f'<pre class="evidence">{escaped}</pre>'


def _impact_html(impact: Optional[Dict[str, Any]]) -> str:
    if not impact:
        return ""
    entities = [*(impact.get("accounts_affected") or []), *(impact.get("domains_affected") or [])]
    rows = [
        ("Mensagens afetadas", str(impact.get("messages_affected", 0))),
        ("Tempo total em aberto", _fmt_duration(impact.get("total_open_seconds"))),
    ]
    if impact.get("stuck_over_4h"):
        rows.append(("Mensagens presas há mais de 4h", str(impact["stuck_over_4h"])))
    if impact.get("delivery_rate_impact_pct") is not None:
        pct = impact["delivery_rate_impact_pct"]
        rows.append(("Impacto na taxa de entrega", f"{'queda' if pct > 0 else 'sem queda relevante' if pct == 0 else 'melhora'} de {abs(pct)} pontos percentuais"))
    if entities:
        rows.append(("Contas/domínios de cliente afetados", ", ".join(entities)))

    rows_html = "".join(f'<tr><td class="muted">{k}</td><td><strong>{v}</strong></td></tr>' for k, v in rows)

    cost_html = ""
    cost = impact.get("cost_estimate")
    if cost:
        cost_html = (
            f'<p class="cost"><strong>Custo estimado: R$ {cost["total_brl"]:.2f}</strong> '
            f'({cost["label"]}) — {cost["basis"]}</p>'
        )

    return f'<table class="kv">{rows_html}</table>{cost_html}'


_CSS = """
  :root { --ink:#1a1f2b; --muted:#6b7280; --border:#e2e8f0; --bg:#ffffff; --accent:#0369a1; --accent-bg:#f0f9ff;
          --ok:#16a34a; --bad:#dc2626; --warn-bg:#fffbeb; --warn-border:#fde68a; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--ink);
         background: #f1f5f9; margin: 0; padding: 32px 16px; }
  .page { max-width: 760px; margin: 0 auto; background: var(--bg); border-radius: 14px; border: 1px solid var(--border);
          overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.06); }
  .header { background: var(--accent); color: #fff; padding: 28px 36px; }
  .header .eyebrow { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.85; margin: 0 0 6px; }
  .header h1 { margin: 0; font-size: 22px; }
  .header .sub { margin: 8px 0 0; font-size: 13px; opacity: 0.9; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 700;
           background: rgba(255,255,255,0.18); margin-right: 6px; }
  .body { padding: 8px 36px 32px; }
  section { margin-top: 26px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--accent); margin: 0 0 10px; }
  p { font-size: 14px; line-height: 1.6; margin: 0 0 8px; }
  .muted { color: var(--muted); font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.kv td { padding: 6px 0; border-bottom: 1px solid var(--border); }
  table.kv td:last-child { text-align: right; }
  table.actions th, table.actions td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--border); font-size: 12.5px; }
  table.actions th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; }
  .ok { color: var(--ok); font-weight: 600; }
  .bad { color: var(--bad); font-weight: 600; }
  .evidence { background: #0f172a; color: #cbd5e1; font-size: 11px; line-height: 1.7; padding: 14px 16px;
              border-radius: 8px; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  .cost { background: var(--warn-bg); border: 1px solid var(--warn-border); border-radius: 8px; padding: 10px 12px; font-size: 13px; }
  .footer { padding: 16px 36px; border-top: 1px solid var(--border); font-size: 11px; color: var(--muted); }
  .toolbar { max-width: 760px; margin: 0 auto 12px; text-align: right; }
  .toolbar button { font-size: 12px; padding: 7px 14px; border-radius: 7px; border: 1px solid var(--border);
                     background: #fff; color: var(--ink); cursor: pointer; }
  @media print {
    body { background: #fff; padding: 0; }
    .toolbar { display: none; }
    .page { border: none; box-shadow: none; border-radius: 0; max-width: 100%; }
    section { page-break-inside: avoid; }
  }
"""


def render_incident_report_html(incident, server_name: str, actions: List[Any], impact: Optional[Dict[str, Any]]) -> str:
    """`impact` vem pronto de quem chama (routers/incidents.py) — o
    congelado (incident.impact) se resolvido, ou calculado ao vivo via
    compute_impact(db, incident) se ainda aberto. Este módulo não toca
    no banco, pra poder ser testado sem ele."""
    type_label = TYPE_LABELS.get(incident.type, incident.type)
    status_label = STATUS_LABELS.get(incident.status, incident.status)

    return f"""<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>Relatório — {incident.display_id}</title>
<style>{_CSS}</style>
</head><body>
<div class="toolbar"><button onclick="window.print()">Imprimir / Salvar como PDF</button></div>
<div class="page">
  <div class="header">
    <p class="eyebrow">Relatório de incidente</p>
    <h1>{incident.display_id} — {type_label}</h1>
    <p class="sub">{server_name} · <span class="badge">{incident.severity.upper()}</span><span class="badge">{status_label}</span></p>
  </div>
  <div class="body">
    <section>
      <h2>O que aconteceu</h2>
      <p>{(incident.suggested_fix or {}).get("description", "Sem descrição registrada.")}</p>
    </section>

    <section>
      <h2>Quando</h2>
      <table class="kv">
        <tr><td class="muted">Detectado em</td><td>{_fmt_dt(incident.first_seen)}</td></tr>
        <tr><td class="muted">Última atividade</td><td>{_fmt_dt(incident.last_seen)}</td></tr>
        <tr><td class="muted">{"Resolvido em" if incident.resolved_at else "Status atual"}</td>
            <td>{_fmt_dt(incident.resolved_at) if incident.resolved_at else status_label}</td></tr>
      </table>
    </section>

    <section>
      <h2>O que causou</h2>
      <p>{_cause_text(incident)}</p>
    </section>

    <section>
      <h2>Impacto</h2>
      {_impact_html(impact)}
    </section>

    <section>
      <h2>O que foi feito</h2>
      <table class="actions">
        <tr><th>Quando</th><th>Ação</th><th>Por quem</th><th>Resultado</th></tr>
        {_actions_rows_html(actions)}
      </table>
    </section>

    <section>
      <h2>O que teria acontecido sem intervenção</h2>
      <p>{_counterfactual_text(incident)}</p>
    </section>

    <section>
      <h2>Evidência técnica</h2>
      <p class="muted">Linhas reais do log do servidor que sustentam este diagnóstico — para quem quiser verificar por conta própria.</p>
      {_evidence_html(incident)}
    </section>
  </div>
  <div class="footer">
    Mail IQ — relatório gerado automaticamente em {datetime.utcnow().strftime("%d/%m/%Y %H:%M")} UTC.
  </div>
</div>
</body></html>"""
