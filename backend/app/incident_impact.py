"""
Sessão 3, Tarefa 1 — impacto por incidente: o número que o dono do
hosting entende sem precisar interpretar um dashboard. Mensagens/contas/
domínios afetados, tempo em aberto e queda na taxa de entrega são sempre
calculados a partir de dado real já persistido (Snapshot/metrics do
próprio incidente) — nunca inventados.

Estimativa financeira é a exceção deliberada: só aparece se o usuário
configurou "custo por hora de sysadmin" e/ou "custo por ticket" em
AlertSettings (Sessão 3, T1) — sem isso, `cost_estimate` fica ausente do
dict, nunca um valor calculado com um custo-padrão chutado. Quando
aparece, vem com `label: "estimativa"` e o `basis` explicando a conta,
nunca como um número solto.

compute_impact() é chamado tanto ao vivo (incidente aberto — sem
gravar, GET /incidents/{id} recalcula a cada leitura) quanto uma única
vez no fechamento (routers/incidents.py::resolve_incident,
incident_engine.py auto-resolve) — aí o resultado é congelado em
Incident.impact e nunca mais recalculado.
"""
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from .database import Incident, Snapshot, get_alert_settings

# Janela "antes" usada como baseline de comparação pra queda na taxa de
# entrega — mesma ordem de grandeza da baseline horária (T3, Sessão 2),
# mas aqui é só uma média simples, não histórico por hora: o objetivo é
# "como estava indo antes disso começar", não detectar o incidente (o
# motor de detecção já fez isso).
_BEFORE_WINDOW = timedelta(hours=24)

# Chaves de `metrics` tentadas nesta ordem pra estimar "mensagens
# afetadas" — cada detector usa um nome de campo diferente pro que é,
# na prática, a mesma ideia (quantidade de mensagens no problema).
_MESSAGE_COUNT_KEYS = (
    "queue_total", "auth_count", "deferred_count", "total_deferred", "frozen_count",
)


def _messages_affected(incident: Incident) -> int:
    metrics = incident.metrics or {}
    for key in _MESSAGE_COUNT_KEYS:
        if key in metrics and isinstance(metrics[key], (int, float)):
            return int(metrics[key])
    observed = (incident.triggered_by or {}).get("observed")
    return int(observed) if isinstance(observed, (int, float)) and observed >= 0 else 0


def _entities_affected(incident: Incident) -> Tuple[List[str], List[str]]:
    """Contas e domínios de cliente afetados — extraído do formato de
    `entity` que cada detector já usa (ver detectors.py), não uma nova
    fonte de dado. Melhor esforço documentado, não uma garantia de
    cobertura total (ex.: `queue_stuck` sem remetente/destino dominante
    usa entity="geral", sem entidade extraível)."""
    entity = incident.entity or ""
    if entity.startswith("domain:"):
        return [], [entity.split(":", 1)[1]]
    if entity.startswith("sender:"):
        return [entity.split(":", 1)[1]], []
    if entity.startswith("ip:") or entity in ("frozen", "geral"):
        return [], []
    if incident.type == "auth_abuse":
        return [entity], []
    return [], []


def _stuck_over_4h(db, incident: Incident, window_start: datetime, window_end: datetime) -> int:
    """Pior valor observado de `queue.age.over_4h` (diag-exim.sh v5.17+)
    entre os snapshots full cobrindo a janela do incidente — só faz
    sentido pra queue_stuck; os demais tipos não têm fila implicada."""
    if incident.type != "queue_stuck":
        return 0
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
    worst = 0
    for s in snaps:
        over_4h = ((s.data or {}).get("queue") or {}).get("age", {}).get("over_4h")
        if isinstance(over_4h, (int, float)):
            worst = max(worst, int(over_4h))
    return worst


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


def _delivery_rate_impact(db, incident: Incident, window_start: datetime, window_end: datetime) -> Optional[float]:
    before = _avg_delivery_rate(db, incident.server_id, window_start - _BEFORE_WINDOW, window_start)
    during = _avg_delivery_rate(db, incident.server_id, window_start, window_end)
    if before is None or during is None:
        return None
    return round(before - during, 1)  # positivo = taxa de entrega caiu


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
        "messages_affected": _messages_affected(incident),
        "stuck_over_4h": _stuck_over_4h(db, incident, window_start, window_end),
        "total_open_seconds": round(total_open_seconds),
        "delivery_rate_impact_pct": _delivery_rate_impact(db, incident, window_start, window_end),
        "computed_at": datetime.utcnow().isoformat() + "Z",
    }
    impact["accounts_affected"], impact["domains_affected"] = _entities_affected(incident)

    cost = _cost_estimate(db, incident, total_open_seconds)
    if cost:
        impact["cost_estimate"] = cost

    return impact


def freeze_impact(db, incident: Incident) -> None:
    """Congela o impacto no fechamento — única gravação em Incident.impact.
    Chamar SEMPRE depois de setar status/resolved_at (usa
    incident.resolved_at, que precisa já estar setado)."""
    incident.impact = compute_impact(db, incident)
