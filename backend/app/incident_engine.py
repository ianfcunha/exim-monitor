"""
Sessão 2, Tarefa 5 — motor de incidentes: chamado por collector.py a
cada ciclo full, depois de salvar o snapshot e amostrar baseline (T3).
Orquestra os 4 detectores (T2) + baseline (T3) + máquina de estados
explícita (Incident/IncidentEvent, T1) + notificação (T4) — nenhuma
dessas peças sabe da existência das outras; este módulo é o único que
as conecta.

Máquina de estados (por fingerprint = tipo+servidor+entidade):
  aberto         → detector encontrou a fingerprint neste ciclo
  em_observacao  → detector NÃO encontrou mais, mas ainda não bateu
                    RESOLVE_AFTER_CLEAN_CYCLES ciclos limpos seguidos
                    (reaparecer volta pra "aberto", evento "reopened" —
                    não notifica: não é abertura nem agravamento novo)
  mitigado       → setado por fora (routers/incidents.py, fix/apply) —
                    este módulo nunca escreve "mitigado"
  resolvido      → RESOLVE_AFTER_CLEAN_CYCLES ciclos limpos seguidos
                    (resolution="automatica") ou resolução manual (fora
                    daqui)

Agravamento: mesma fingerprint, `triggered_by.observed` numérico maior
que o do incidente já aberto — NÃO cria incidente novo, adiciona
evento "escalated" ao existente.
"""
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from .baseline import make_baseline_fn
from .database import (
    Incident, Snapshot, get_detector_config_overrides, record_incident_event,
)
from .incident_impact import freeze_impact
from .detectors import (
    Candidate, detect_auth_abuse, detect_dest_deferral, detect_queue_stuck, detect_reputation,
)
from .incident_notify import notify_incident_event
from .ssh import SSHError, get_log_entries, run_action

logger = logging.getLogger(__name__)

RESOLVE_AFTER_CLEAN_CYCLES = 3
# Cobre o maior "consecutive_cycles"/"frozen_consecutive_cycles" possível
# entre os thresholds padrão E qualquer override razoável — folga de
# segurança, não um valor mágico ajustado a um único threshold.
QUEUE_SNAPSHOT_LOOKBACK = 10

_EVIDENCE_LINES_LIMIT = 10


def _fetch_evidence(server_cfg: Optional[Dict[str, Any]], hint: Dict[str, Any]) -> List[str]:
    """
    Busca linhas reais do mainlog que sustentam o diagnóstico (painel de
    evidência — "o item mais importante da tela", Tarefa 6). Só chamado
    na abertura/agravamento (não a cada ciclo) para não multiplicar SSH.
    Best-effort: falha aqui não pode impedir o incidente de ser
    registrado — evidência vazia é degradação aceitável, não um erro.
    """
    if not server_cfg or not hint or not hint.get("log_filter"):
        return []
    try:
        entries = get_log_entries(hint["log_filter"], limit=300, server_cfg=server_cfg)
    except SSHError as exc:
        logger.debug("Falha ao buscar evidência (%s): %s", hint, exc)
        return []
    match = hint.get("match") or ""
    if match:
        entries = [e for e in entries if match in e.get("raw", "")]
    return [e["raw"] for e in entries[:_EVIDENCE_LINES_LIMIT]]


def _is_worse(old_triggered_by: Optional[Dict[str, Any]], new_triggered_by: Dict[str, Any]) -> bool:
    """Heurística única pros 4 tipos: compara `observed` (todo detector
    expõe esse campo numérico em triggered_by) em vez de um comparador
    por tipo — mais métrica ruim = agravamento, sem duplicar lógica."""
    if not old_triggered_by:
        return False
    old_obs, new_obs = old_triggered_by.get("observed"), new_triggered_by.get("observed")
    if isinstance(old_obs, (int, float)) and isinstance(new_obs, (int, float)):
        return new_obs > old_obs
    return False


def evaluate_incidents(db, server_id: int, data: Dict[str, Any],
                       deliverability: Optional[Dict[str, Any]],
                       server_cfg: Optional[Dict[str, Any]]) -> None:
    baseline_fn = make_baseline_fn(db, server_id)

    recent_snaps = (
        db.query(Snapshot)
        .filter(Snapshot.server_id == server_id, Snapshot.mode == "full")
        .order_by(Snapshot.timestamp.desc())
        .limit(QUEUE_SNAPSHOT_LOOKBACK)
        .all()
    )
    # collector.py já persistiu o snapshot deste ciclo antes de chamar
    # isto — recent_snaps[0] É o ciclo atual, detect_queue_stuck() conta
    # com isso (ver docstring lá).
    recent_full = [s.data or {} for s in recent_snaps]

    candidates: List[Candidate] = []
    candidates += detect_auth_abuse(
        data, get_detector_config_overrides(db, server_id, "auth_abuse"), baseline_fn)
    candidates += detect_reputation(
        deliverability, data, get_detector_config_overrides(db, server_id, "reputation"))
    candidates += detect_queue_stuck(
        recent_full, data, get_detector_config_overrides(db, server_id, "queue_stuck"), baseline_fn)
    candidates += detect_dest_deferral(
        data, get_detector_config_overrides(db, server_id, "dest_deferral"))

    candidates_by_fp: Dict[str, Candidate] = {
        f"{c['type']}:{server_id}:{c['entity']}": c for c in candidates
    }

    open_incidents = (
        db.query(Incident)
        .filter(Incident.server_id == server_id, Incident.status.in_(["aberto", "em_observacao", "mitigado"]))
        .all()
    )
    open_by_fp = {i.fingerprint: i for i in open_incidents}
    now = datetime.utcnow()

    # ── 1) incidentes já abertos: atualiza, agrava, ou conta ciclo limpo ──
    for fp, incident in open_by_fp.items():
        cand = candidates_by_fp.get(fp)

        if cand is None:
            incident.consecutive_clean += 1
            if incident.consecutive_clean >= RESOLVE_AFTER_CLEAN_CYCLES:
                incident.status = "resolvido"
                incident.resolved_at = now
                incident.resolution = "automatica"
                freeze_impact(db, incident)  # Sessão 3, T1 — mesmo congelamento do fechamento manual (routers/incidents.py)
                record_incident_event(db, incident, "resolved", actor="system",
                                      detail={"consecutive_clean": incident.consecutive_clean})
                db.commit()
                notify_incident_event(incident, "resolved")
            else:
                if incident.status == "aberto":
                    incident.status = "em_observacao"
                db.commit()
            continue

        was_observacao = incident.status == "em_observacao"
        worse = _is_worse(incident.triggered_by, cand["triggered_by"])

        incident.last_seen = now
        incident.metrics = cand["metrics"]
        incident.triggered_by = cand["triggered_by"]
        incident.suggested_fix = cand["suggested_fix"]
        incident.consecutive_clean = 0
        if incident.status == "em_observacao":
            incident.status = "aberto"
        elif incident.status == "mitigado" and worse:
            # A correção aplicada não segurou — volta a "aberto" (não é
            # silenciosamente ignorado como "mitigado" para sempre).
            incident.status = "aberto"

        if worse:
            evidence = _fetch_evidence(server_cfg, cand["evidence_hint"])
            if evidence:
                incident.evidence = {"lines": evidence}
            record_incident_event(db, incident, "escalated", actor="system", detail={"metrics": cand["metrics"]})
            db.commit()
            notify_incident_event(incident, "escalated")
        elif was_observacao:
            # Reapareceu sem agravar — real, mas não é abertura nem
            # agravamento; registra sem notificar (T4: só 3 tipos notificam).
            record_incident_event(db, incident, "reopened", actor="system")
            db.commit()
        else:
            db.commit()

    # ── 2) candidatos novos (sem incidente aberto correspondente) ──
    for fp, cand in candidates_by_fp.items():
        if fp in open_by_fp:
            continue
        evidence = _fetch_evidence(server_cfg, cand["evidence_hint"])
        incident = Incident(
            server_id=server_id, type=cand["type"], severity=cand["severity"], status="aberto",
            fingerprint=fp, entity=cand["entity"], first_seen=now, last_seen=now,
            evidence={"lines": evidence} if evidence else None,
            metrics=cand["metrics"], suggested_fix=cand["suggested_fix"], triggered_by=cand["triggered_by"],
        )
        db.add(incident)
        db.commit()
        db.refresh(incident)
        record_incident_event(db, incident, "opened", actor="system")
        db.commit()
        notify_incident_event(incident, "opened")


def run_incident_cycle(db_factory, server_id: int, data: Dict[str, Any],
                       server_cfg: Optional[Dict[str, Any]]) -> None:
    """
    Wrapper síncrono chamado por collector.py via asyncio.to_thread
    (tudo aqui dentro é I/O bloqueante: SSH + Postgres). Busca
    check-deliverability (best-effort — reputation fica sem candidatos
    se falhar, os outros 3 detectores seguem normalmente) e chama
    evaluate_incidents() numa sessão própria.
    """
    deliverability = None
    if server_cfg:
        try:
            result = run_action("check-deliverability", None, server_cfg=server_cfg, actor="incident-engine")
            if result.get("success", True) is not False:
                deliverability = result
        except SSHError as exc:
            logger.debug("check-deliverability falhou (server_id=%s), reputation pulado: %s", server_id, exc)
        except Exception:
            logger.exception("Erro inesperado em check-deliverability (server_id=%s)", server_id)

    db = db_factory()
    try:
        evaluate_incidents(db, server_id, data, deliverability, server_cfg)
    except Exception:
        db.rollback()
        logger.exception("Erro no motor de incidentes (server_id=%s)", server_id)
    finally:
        db.close()
