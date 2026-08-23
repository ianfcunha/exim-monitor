"""
Impacto por incidente.

Sessão 4, Tarefa 6 — impacto honesto. A versão anterior exibia
"IMPACTO NA ENTREGA +0.4 p.p." idêntico nos dois incidentes abertos, um
deles com "mensagens afetadas: 0". Eram três defeitos ao mesmo tempo:

  1. Métrica do SERVIDOR sendo exibida como métrica do INCIDENTE. A
     variação da taxa de entrega na janela é do servidor inteiro; com
     dois incidentes simultâneos ela não é atribuível a nenhum dos dois.

  2. Sinal invertido dentro de um card vermelho. Uma variação POSITIVA
     (a entrega melhorou) aparecia como "impacto" de um incidente
     crítico.

  3. Um número onde não havia número. "Mensagens afetadas: 0" para um
     incidente de reputação não é zero mensagens afetadas — é que
     reputação não tem um lote de mensagens próprio para contar.

A regra que vale daqui em diante: quando um valor não pode ser
calculado com confiança para AQUELE tipo de incidente, não se exibe
número. Exibe-se "não estimável", com o motivo em uma linha.

Estrutura: todo valor de impacto é um dict
    {"estimable": True,  "value": X, "basis": "como foi calculado"}
ou  {"estimable": False, "reason": "por que não dá pra estimar"}
— nunca um número solto que o frontend precise adivinhar se é confiável.

compute_impact() é chamado ao vivo enquanto o incidente está aberto
(GET /incidents/{id} recalcula a cada leitura, sem gravar) e uma única
vez no fechamento (routers/incidents.py::resolve_incident e o
auto-resolve de incident_engine.py) — aí o resultado é congelado em
Incident.impact e nunca mais recalculado.
"""
import re
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from .database import Incident, Snapshot, get_alert_settings

_IP_RE = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$|^[0-9a-fA-F:]+$")

# Janela "antes" usada como baseline de comparação pra queda na taxa de
# entrega — "como estava indo antes disso começar".
_BEFORE_WINDOW = timedelta(hours=24)

# Chaves de `metrics` que representam um lote de mensagens realmente
# atribuível ao incidente, por tipo. Reputação não aparece aqui de
# propósito: o IP listado afeta toda a saída do servidor, não um
# conjunto identificável de mensagens.
_MESSAGE_COUNT_KEYS_BY_TYPE = {
    "auth_abuse": ("auth_count",),
    "queue_stuck": ("queue_total", "frozen_count"),
    "dest_deferral": ("deferred_count",),
}


def estimable(value: Any, basis: str = "") -> Dict[str, Any]:
    return {"estimable": True, "value": value, "basis": basis}


def not_estimable(reason: str) -> Dict[str, Any]:
    return {"estimable": False, "reason": reason}


def _messages_affected(incident: Incident) -> Dict[str, Any]:
    keys = _MESSAGE_COUNT_KEYS_BY_TYPE.get(incident.type)
    if not keys:
        return not_estimable(
            "reputação não tem um lote de mensagens próprio — o IP ou domínio afeta "
            "toda a saída do servidor, não um conjunto identificável de mensagens"
        )
    metrics = incident.metrics or {}
    for key in keys:
        if isinstance(metrics.get(key), (int, float)) and not isinstance(metrics.get(key), bool):
            return estimable(int(metrics[key]), f"campo '{key}' medido na abertura do incidente")
    return not_estimable("a coleta deste incidente não registrou uma contagem de mensagens")


def _entities_affected(incident: Incident) -> Tuple[List[str], List[str]]:
    """Contas e domínios de cliente afetados — extraído do formato de
    `entity` que cada detector já usa. Melhor esforço documentado, não
    uma garantia de cobertura total."""
    entity = incident.entity or ""
    if entity.startswith("domain:"):
        value = entity.split(":", 1)[1]
        # Um IP aqui não é um domínio de cliente, é o próprio servidor.
        if _IP_RE.match(value):
            return [], []
        return [], [value]
    if entity.startswith("sender:"):
        return [entity.split(":", 1)[1]], []
    if entity.startswith("ip:") or entity.startswith("host:") or entity in ("frozen", "geral"):
        return [], []
    if incident.type == "auth_abuse":
        return [entity], []
    return [], []


def _stuck_over_4h(db, incident: Incident, window_start: datetime, window_end: datetime) -> Dict[str, Any]:
    """Pior valor observado de `queue.age.over_4h` entre os snapshots
    full cobrindo a janela do incidente — só faz sentido pra fila
    travada; os demais tipos não têm fila implicada."""
    if incident.type != "queue_stuck":
        return not_estimable("só se aplica a incidentes de fila travada")
    snaps = (
        db.query(Snapshot)
        .filter(
            Snapshot.server_id == incident.server_id,
            Snapshot.mode == "full",
            Snapshot.timestamp >= window_start,
            Snapshot.timestamp <= window_end,
        )
        .all()
    )
    worst = None
    for s in snaps:
        over_4h = ((s.data or {}).get("queue") or {}).get("age", {}).get("over_4h")
        if isinstance(over_4h, (int, float)):
            worst = max(worst or 0, int(over_4h))
    if worst is None:
        return not_estimable("nenhuma coleta completa cobriu a janela deste incidente")
    return estimable(worst, "pior valor observado nas coletas durante o incidente")


def _avg_delivery_rate(db, server_id: int, start: datetime, end: datetime) -> Optional[float]:
    snaps = (
        db.query(Snapshot)
        .filter(Snapshot.server_id == server_id, Snapshot.mode == "full",
                Snapshot.timestamp >= start, Snapshot.timestamp <= end)
        .all()
    )
    rates = []
    for s in snaps:
        attempts = (s.delivered or 0) + (s.rejected or 0)
        if attempts > 0:
            rates.append(s.delivered / attempts)
    return round(sum(rates) / len(rates) * 100, 1) if rates else None


def _concurrent_incidents(db, incident: Incident, start: datetime, end: datetime) -> int:
    """Outros incidentes que estiveram abertos ao mesmo tempo neste
    servidor. É o que decide se a variação da taxa de entrega pode ser
    atribuída a ESTE incidente ou a nenhum."""
    return (
        db.query(Incident)
        .filter(
            Incident.server_id == incident.server_id,
            Incident.id != incident.id,
            Incident.first_seen <= end,
            (Incident.resolved_at.is_(None)) | (Incident.resolved_at >= start),
        )
        .count()
    )


def _delivery_rate_impact(db, incident: Incident, window_start: datetime,
                          window_end: datetime) -> Dict[str, Any]:
    """
    Queda na taxa de entrega atribuível a este incidente — em pontos
    percentuais, sempre como QUEDA (nunca uma variação positiva exibida
    como impacto de um incidente crítico).
    """
    if incident.type == "reputation":
        return not_estimable(
            "estar listado numa blocklist não muda a taxa de entrega medida no próprio "
            "servidor: o Exim registra a mensagem como entregue e é o provedor de "
            "destino que a descarta depois — veja os dados de listagem abaixo"
        )

    concurrent = _concurrent_incidents(db, incident, window_start, window_end)
    if concurrent:
        return not_estimable(
            f"houve {concurrent} outro(s) incidente(s) aberto(s) neste servidor durante a "
            f"mesma janela — a variação da taxa de entrega é do servidor e não pode ser "
            f"atribuída a um incidente específico"
        )

    before = _avg_delivery_rate(db, incident.server_id, window_start - _BEFORE_WINDOW, window_start)
    during = _avg_delivery_rate(db, incident.server_id, window_start, window_end)
    if before is None:
        return not_estimable("não há coletas suficientes nas 24h anteriores para servir de comparação")
    if during is None:
        return not_estimable("não há coletas com tentativas de entrega durante a janela do incidente")

    drop = round(before - during, 1)
    if drop <= 0:
        return estimable(0.0, f"a taxa de entrega não caiu durante o incidente "
                              f"({before}% antes, {during}% durante)")
    return estimable(drop, f"{before}% de entrega nas 24h anteriores contra {during}% durante o incidente")


def _reputation_detail(db, incident: Incident, window_start: datetime,
                       window_end: datetime) -> Dict[str, Any]:
    """
    Sessão 4, T6 — para reputação, o card de "impacto na entrega" é
    trocado por algo verificável: há quanto tempo está listado, em
    quantas zonas, e quanto o servidor entregou nesse período.
    """
    metrics = incident.metrics or {}
    listed_minutes = int((window_end - window_start).total_seconds() // 60)

    zones = metrics.get("blocklists_listed") or []
    detail: Dict[str, Any] = {
        "listed_minutes": estimable(listed_minutes, "desde a primeira leitura confirmada da listagem"),
        "zones_listed": estimable(zones, f"{len(zones)} zona(s) responderam com listagem")
                        if zones else not_estimable("este incidente de reputação não é uma listagem em blocklist"),
        "zones_checked": estimable(metrics["zones_checked"], "zonas que responderam de forma conclusiva")
                         if isinstance(metrics.get("zones_checked"), int)
                         else not_estimable("a coleta não registrou quantas zonas foram consultadas"),
    }

    snaps = (
        db.query(Snapshot)
        .filter(Snapshot.server_id == incident.server_id, Snapshot.mode == "full",
                Snapshot.timestamp >= window_start, Snapshot.timestamp <= window_end)
        .all()
    )
    dest_counts = [
        ((s.data or {}).get("top_dest_domain"), ((s.data or {}).get("top_dest_domain_count") or 0))
        for s in snaps
    ]
    named = [(d, c) for d, c in dest_counts if d and c]
    if named:
        worst_domain, worst_count = max(named, key=lambda t: t[1])
        detail["messages_to_top_destination"] = estimable(
            {"domain": worst_domain, "count": worst_count},
            "maior volume observado para um único domínio de destino durante a listagem — "
            "é a melhor aproximação disponível de 'quantas mensagens saíram para um provedor "
            "que consulta esta zona'",
        )
    else:
        detail["messages_to_top_destination"] = not_estimable(
            "nenhuma coleta durante a listagem registrou domínio de destino com volume — "
            "sem isso não dá para dizer quantas mensagens foram para provedores que "
            "consultam esta zona"
        )
    return detail


def _cost_estimate(db, incident: Incident, total_open_seconds: float) -> Optional[Dict[str, Any]]:
    cfg = get_alert_settings(db, server_id=incident.server_id)
    per_hour = cfg.cost_per_sysadmin_hour_brl
    per_ticket = cfg.cost_per_ticket_brl
    if not per_hour and not per_ticket:
        return None

    hours_open = round(total_open_seconds / 3600, 2)
    labor = round(per_hour * hours_open, 2) if per_hour else None
    ticket = round(per_ticket, 2) if per_ticket else None  # 1 ticket assumido por incidente
    total = round((labor or 0) + (ticket or 0), 2)

    basis_parts = []
    if labor is not None:
        basis_parts.append(f"{hours_open}h em aberto × R$ {per_hour:.2f}/h de sysadmin")
    if ticket is not None:
        basis_parts.append(f"1 ticket de suporte × R$ {per_ticket:.2f}/ticket")

    return {
        "label": "estimativa",
        "labor_brl": labor,
        "ticket_brl": ticket,
        "total_brl": total,
        "basis": " + ".join(basis_parts),
    }


def compute_impact(db, incident: Incident) -> Dict[str, Any]:
    window_end = incident.resolved_at or datetime.utcnow()
    window_start = incident.first_seen
    total_open_seconds = max(0.0, (window_end - window_start).total_seconds())

    impact: Dict[str, Any] = {
        "incident_type": incident.type,
        "messages_affected": _messages_affected(incident),
        "stuck_over_4h": _stuck_over_4h(db, incident, window_start, window_end),
        "total_open_seconds": round(total_open_seconds),
        "delivery_rate_impact_pct": _delivery_rate_impact(db, incident, window_start, window_end),
        "computed_at": datetime.utcnow().isoformat() + "Z",
    }
    impact["accounts_affected"], impact["domains_affected"] = _entities_affected(incident)

    if incident.type == "reputation":
        impact["reputation"] = _reputation_detail(db, incident, window_start, window_end)

    cost = _cost_estimate(db, incident, total_open_seconds)
    if cost:
        impact["cost_estimate"] = cost

    return impact


def normalize_impact(impact: Optional[Dict[str, Any]], incident_type: str) -> Optional[Dict[str, Any]]:
    """Impactos congelados antes da T6 guardam números soltos
    (`"messages_affected": 1`) em vez de `{estimable, value, basis}`.
    Eles estão no banco e continuam sendo lidos por incidentes já
    resolvidos, então quem consome impacto passa por aqui primeiro.

    A conversão aplica a MESMA regra do cálculo novo, não um
    empacotamento cego do número velho: um valor que hoje não seria
    estimável para aquele tipo não vira número só por estar congelado.
    """
    if not impact:
        return impact
    out = dict(impact)
    out.setdefault("incident_type", incident_type)

    if not isinstance(out.get("messages_affected"), dict):
        value = out.get("messages_affected")
        if incident_type not in _MESSAGE_COUNT_KEYS_BY_TYPE:
            out["messages_affected"] = not_estimable(
                "reputação não tem um lote de mensagens próprio — o IP ou domínio afeta "
                "toda a saída do servidor, não um conjunto identificável de mensagens"
            )
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            out["messages_affected"] = estimable(int(value), "valor congelado no fechamento deste incidente")
        else:
            out["messages_affected"] = not_estimable("a coleta deste incidente não registrou uma contagem de mensagens")

    if not isinstance(out.get("stuck_over_4h"), dict):
        value = out.get("stuck_over_4h")
        if incident_type != "queue_stuck":
            out["stuck_over_4h"] = not_estimable("só se aplica a incidentes de fila travada")
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            out["stuck_over_4h"] = estimable(int(value), "valor congelado no fechamento deste incidente")
        else:
            out["stuck_over_4h"] = not_estimable("nenhuma coleta completa cobriu a janela deste incidente")

    # O número antigo era a variação da taxa de entrega do SERVIDOR na
    # janela, sem checar incidentes simultâneos e sem descartar variação
    # positiva — os dois defeitos que a T6 corrigiu. Recalcular exigiria
    # os snapshots da época; afirmar o número velho seria repetir o
    # defeito. Fica não estimável, com o motivo.
    if not isinstance(out.get("delivery_rate_impact_pct"), dict):
        out["delivery_rate_impact_pct"] = not_estimable(
            "incidente fechado antes da revisão de impacto: o valor congelado era a variação "
            "da taxa de entrega do servidor inteiro na janela, que não é atribuível a um "
            "incidente específico"
        )

    return out


def freeze_impact(db, incident: Incident) -> None:
    """Congela o impacto no fechamento — única gravação em Incident.impact.
    Chamar SEMPRE depois de setar status/resolved_at (usa
    incident.resolved_at, que precisa já estar setado)."""
    incident.impact = compute_impact(db, incident)
