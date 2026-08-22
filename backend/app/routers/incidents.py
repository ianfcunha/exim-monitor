"""
Sessão 2, Tarefa 5 — API de incidentes. A tela de Triagem (Tarefa 6) é
o único consumidor pensado, mas a API é o contrato real: tudo que a UI
faz passa por aqui, sem atalho direto pro banco.

GET  /api/incidents               — lista cross-fleet por padrão (filtros: status, severity, server_id)
GET  /api/incidents/summary       — frase de estado da frota (cabeçalho da Triagem)
GET  /api/incidents/{id}          — detalhe (métricas, evidência, sugestão, eventos)
POST /api/incidents/{id}/ack
POST /api/incidents/{id}/silence
POST /api/incidents/{id}/resolve
POST /api/incidents/{id}/fix/plan  — reusa plan() da Sessão 1 (T3)
POST /api/incidents/{id}/fix/apply — reusa apply() da Sessão 1 (T3)
GET/PUT /api/incidents/config      — threshold por tipo, formulário simples (não uma aba "Regras")
"""
import uuid
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..auth import get_current_user, require_admin
from ..crypto import SecretDecryptionError
from ..database import (
    ActionPlan, DetectorConfig, Incident, IncidentEvent, User, build_server_cfg, get_db,
    get_detector_config_overrides, get_server_owned_by, get_servers_for_user, record_action_history,
    record_incident_event, save_detector_config_overrides, to_utc_iso,
)
from ..detectors import DEFAULT_THRESHOLDS
from ..incident_notify import notify_incident_event
from ..ssh import SSHError, run_action

router = APIRouter(prefix="/api/incidents", tags=["incidents"])

PLAN_MAX_AGE_SECONDS = 300  # mesmo valor de routers/actions.py — mesma garantia de frescor
OPEN_STATUSES = ("aberto", "em_observacao", "mitigado")

# "como reverter" — descrição genérica por tipo de ação, mostrada já no
# preview do plan() (o id real da quarentena só existe depois do apply,
# mas o MECANISMO de reversão é conhecido de antemão). Tela de Triagem
# (T6) mostra isto junto do preview antes de qualquer coisa acontecer.
_REVERT_DESCRIPTIONS = {
    "clean-frozen":  "Reversível — as mensagens vão para quarentena antes de remover; restaure em Configurações → Manutenção.",
    "clean-bounces": "Reversível — as mensagens vão para quarentena antes de remover; restaure em Configurações → Manutenção.",
    "clean-sender":  "Reversível — as mensagens vão para quarentena antes de remover; restaure em Configurações → Manutenção.",
    "clean-auth":    "Reversível — as mensagens vão para quarentena antes de remover; restaure em Configurações → Manutenção.",
    "block-ip":      "Reversível — desbloqueie o IP a qualquer momento (bloqueio já tem TTL automático).",
    "block-sender":  "Sem reversão de um clique — remover exige editar /etc/exim4/spammer_sender manualmente no servidor.",
    "retry-queue":   "Nada a reverter — só força reprocessamento, não remove nem bloqueia nada.",
}


# ── Helpers de escopo/serialização ──────────────────────────────────────────

def _visible_server_ids(db: Session, current_user: User) -> list[int]:
    return [s.id for s in get_servers_for_user(db, current_user)]


def _get_incident_or_404(db: Session, incident_id: int, current_user: User) -> Incident:
    incident = db.get(Incident, incident_id)
    if not incident or incident.server_id not in _visible_server_ids(db, current_user):
        raise HTTPException(404, f"Incidente {incident_id} não encontrado.")
    return incident


def _incident_to_dict(incident: Incident, server_name: Optional[str] = None, include_events: bool = False) -> dict:
    d = {
        "id": incident.id,
        "display_id": incident.display_id,
        "server_id": incident.server_id,
        "server_name": server_name,
        "type": incident.type,
        "severity": incident.severity,
        "status": incident.status,
        "entity": incident.entity,
        "fingerprint": incident.fingerprint,
        "first_seen": to_utc_iso(incident.first_seen),
        "last_seen": to_utc_iso(incident.last_seen),
        "resolved_at": to_utc_iso(incident.resolved_at),
        "resolution": incident.resolution,
        "evidence": incident.evidence,
        "metrics": incident.metrics,
        "suggested_fix": incident.suggested_fix,
        "triggered_by": incident.triggered_by,
        "silenced_until": to_utc_iso(incident.silenced_until),
    }
    if include_events:
        d["events"] = [
            {"event_type": e.event_type, "at": to_utc_iso(e.at), "actor": e.actor, "detail": e.detail}
            for e in incident.events
        ]
    return d


def _server_cfg_for(db: Session, incident: Incident):
    server = incident.server
    if not server:
        raise HTTPException(404, "Servidor do incidente não encontrado.")
    try:
        return build_server_cfg(server)
    except SecretDecryptionError as exc:
        server.ssh_status, server.ssh_error_msg = "credential_error", str(exc)[:500]
        db.commit()
        raise HTTPException(503, str(exc)) from exc


# ── Listagem ─────────────────────────────────────────────────────────────

@router.get("", summary="Lista incidentes (cross-fleet por padrão)")
def list_incidents(
    status: Optional[str] = Query(None, description="aberto | em_observacao | mitigado | resolvido"),
    severity: Optional[str] = Query(None, description="critico | atencao"),
    server_id: Optional[int] = Query(None),
    limit: int = Query(default=200, ge=1, le=1000),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    visible_ids = _visible_server_ids(db, current_user)
    if server_id is not None:
        if server_id not in visible_ids:
            raise HTTPException(404, f"Servidor {server_id} não encontrado.")
        visible_ids = [server_id]

    q = db.query(Incident).filter(Incident.server_id.in_(visible_ids))
    if status:
        q = q.filter(Incident.status == status)
    if severity:
        q = q.filter(Incident.severity == severity)
    rows = q.order_by(Incident.last_seen.desc()).limit(limit).all()

    names = {s.id: s.name for s in get_servers_for_user(db, current_user)}
    return [_incident_to_dict(r, server_name=names.get(r.server_id)) for r in rows]


@router.get("/summary", summary="Frase de estado da frota (cabeçalho da Triagem)")
def incidents_summary(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    visible_ids = _visible_server_ids(db, current_user)
    open_rows = (
        db.query(Incident)
        .filter(Incident.server_id.in_(visible_ids), Incident.status.in_(OPEN_STATUSES))
        .all()
    )
    n_critico = sum(1 for i in open_rows if i.severity == "critico")
    n_atencao = sum(1 for i in open_rows if i.severity == "atencao")
    servers_affected = len({i.server_id for i in open_rows})

    if n_critico == 0 and n_atencao == 0:
        headline = "Entrega normal — nenhum incidente ativo"
    elif n_critico > 0:
        headline = f"Entrega degradada — {n_critico + n_atencao} incidente{'s' if (n_critico + n_atencao) != 1 else ''} ativo{'s' if (n_critico + n_atencao) != 1 else ''}"
    else:
        headline = f"Sob observação — {n_atencao} incidente{'s' if n_atencao != 1 else ''} de atenção"

    return {
        "headline": headline,
        "open_critico": n_critico,
        "open_atencao": n_atencao,
        "servers_affected": servers_affected,
    }


@router.get("/{incident_id}", summary="Detalhe do incidente (com histórico de eventos)")
def get_incident(incident_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    incident = _get_incident_or_404(db, incident_id, current_user)
    server = incident.server
    return _incident_to_dict(incident, server_name=server.name if server else None, include_events=True)


# ── Transições manuais ──────────────────────────────────────────────────────

@router.post("/{incident_id}/ack", summary="Confirma ciência do incidente (admin only)")
def ack_incident(incident_id: int, db: Session = Depends(get_db), current_user: User = Depends(require_admin)):
    incident = _get_incident_or_404(db, incident_id, current_user)
    record_incident_event(db, incident, "ack", actor=current_user.username)
    db.commit()
    return _incident_to_dict(incident)


class SilenceRequest(BaseModel):
    minutes: int = 60


@router.post("/{incident_id}/silence", summary="Silencia notificações deste incidente (admin only)")
def silence_incident(incident_id: int, body: SilenceRequest, db: Session = Depends(get_db),
                     current_user: User = Depends(require_admin)):
    if body.minutes <= 0:
        raise HTTPException(422, "minutes deve ser positivo.")
    incident = _get_incident_or_404(db, incident_id, current_user)
    incident.silenced_until = datetime.utcnow() + timedelta(minutes=body.minutes)
    record_incident_event(db, incident, "silenced", actor=current_user.username, detail={"minutes": body.minutes})
    db.commit()
    return _incident_to_dict(incident)


class ResolveRequest(BaseModel):
    resolution: str = "manual"  # manual | expirada


@router.post("/{incident_id}/resolve", summary="Resolve o incidente manualmente (admin only)")
def resolve_incident(incident_id: int, body: ResolveRequest = ResolveRequest(), db: Session = Depends(get_db),
                     current_user: User = Depends(require_admin)):
    if body.resolution not in ("manual", "expirada"):
        raise HTTPException(422, "resolution deve ser 'manual' ou 'expirada'.")
    incident = _get_incident_or_404(db, incident_id, current_user)
    if incident.status == "resolvido":
        raise HTTPException(409, "Este incidente já está resolvido.")
    incident.status = "resolvido"
    incident.resolved_at = datetime.utcnow()
    incident.resolution = body.resolution
    record_incident_event(db, incident, "resolved", actor=current_user.username)
    db.commit()
    notify_incident_event(incident, "resolved")
    return _incident_to_dict(incident)


# ── Correção sugerida: plan()/apply() (reusa T3, Sessão 1) ──────────────────

@router.post("/{incident_id}/fix/plan", summary="Preview da correção sugerida — não altera nada (admin only)")
def plan_incident_fix(incident_id: int, db: Session = Depends(get_db), current_user: User = Depends(require_admin)):
    incident = _get_incident_or_404(db, incident_id, current_user)
    action_spec = (incident.suggested_fix or {}).get("action")
    if not action_spec or not action_spec.get("action"):
        raise HTTPException(400, "Este incidente não tem uma correção executável — a orientação é manual (ver suggested_fix.description).")

    action, param = action_spec["action"], action_spec.get("param")
    server_cfg = _server_cfg_for(db, incident)

    try:
        result = run_action(action, param, server_cfg=server_cfg, actor=current_user.username, dry_run=True)
    except SSHError as exc:
        raise HTTPException(503, str(exc))

    plan_id = uuid.uuid4().hex
    db.add(ActionPlan(
        id=plan_id, server_id=incident.server_id, actor=current_user.username,
        action=action, param=param, preview=result,
    ))
    db.commit()
    return {
        "plan_id": plan_id, "expires_in_seconds": PLAN_MAX_AGE_SECONDS, "preview": result,
        "action": action, "param": param,
        "revert_description": _REVERT_DESCRIPTIONS.get(action, "Mecanismo de reversão não documentado para esta ação."),
    }


class ApplyFixRequest(BaseModel):
    plan_id: str
    snapshot: bool = True


@router.post("/{incident_id}/fix/apply", summary="Executa a correção sugerida — requer plan_id (admin only)")
def apply_incident_fix(incident_id: int, body: ApplyFixRequest, db: Session = Depends(get_db),
                       current_user: User = Depends(require_admin)):
    incident = _get_incident_or_404(db, incident_id, current_user)
    action_spec = (incident.suggested_fix or {}).get("action")
    if not action_spec or not action_spec.get("action"):
        raise HTTPException(400, "Este incidente não tem uma correção executável.")
    action, param = action_spec["action"], action_spec.get("param")

    plan = db.get(ActionPlan, body.plan_id)
    if not plan:
        raise HTTPException(404, f"Plano '{body.plan_id}' não encontrado.")
    if plan.consumed_at is not None:
        raise HTTPException(409, "Este plano já foi aplicado — gere um novo em /fix/plan.")
    if plan.action != action or plan.server_id != incident.server_id or (plan.param or None) != (param or None):
        raise HTTPException(409, "O plano não corresponde exatamente a esta correção — gere um novo em /fix/plan.")
    age = (datetime.utcnow() - plan.created_at).total_seconds()
    if age > PLAN_MAX_AGE_SECONDS:
        raise HTTPException(409, f"Plano expirado ({int(age)}s atrás) — gere um novo em /fix/plan.")
    plan.consumed_at = datetime.utcnow()
    db.commit()

    server_cfg = _server_cfg_for(db, incident)
    try:
        result = run_action(
            action, param, server_cfg=server_cfg, actor=current_user.username,
            snapshot=body.snapshot, incident=body.plan_id,
        )
    except SSHError as exc:
        record_action_history(
            db, server_id=incident.server_id, actor=current_user.username, action=action,
            param=param, success=False, message=str(exc), plan_id=body.plan_id, incident_id=incident.id,
        )
        raise HTTPException(503, str(exc))

    if result.get("quarantine_incident"):
        revert_hint = f"restore-quarantine:{result['quarantine_incident']}"
    elif action == "block-ip" and param:
        revert_hint = f"unblock-ip:{param}"
    else:
        revert_hint = None
    record_action_history(
        db, server_id=incident.server_id, actor=current_user.username, action=action,
        param=param, success=result.get("success", False), message=result.get("message"),
        plan_id=body.plan_id, revert_hint=revert_hint, incident_id=incident.id,
    )

    if result.get("success", False):
        incident.status = "mitigado"
        record_incident_event(db, incident, "mitigated", actor=current_user.username,
                              detail={"action": action, "param": param})
        db.commit()
    else:
        raise HTTPException(422, result.get("message", "Ação retornou falha sem mensagem."))

    return result


# ── Configuração de thresholds — formulário simples, não uma aba "Regras" ──

@router.get("/config/{server_id}", summary="Thresholds efetivos por tipo (admin only)")
def get_incident_config(server_id: int, db: Session = Depends(get_db), current_user: User = Depends(require_admin)):
    server = get_server_owned_by(db, server_id, current_user)
    if not server:
        raise HTTPException(404, f"Servidor {server_id} não encontrado.")
    out = {}
    for detector_type, defaults in DEFAULT_THRESHOLDS.items():
        overrides = get_detector_config_overrides(db, server_id, detector_type)
        effective = dict(defaults)
        effective.update({k: v for k, v in overrides.items() if k in defaults})
        out[detector_type] = {"defaults": defaults, "overrides": overrides, "effective": effective}
    return out


class DetectorConfigRequest(BaseModel):
    thresholds: dict


@router.put("/config/{server_id}/{detector_type}", summary="Sobrescreve thresholds de um tipo (admin only)")
def put_incident_config(server_id: int, detector_type: str, body: DetectorConfigRequest,
                        db: Session = Depends(get_db), current_user: User = Depends(require_admin)):
    if detector_type not in DEFAULT_THRESHOLDS:
        raise HTTPException(400, f"Tipo desconhecido: '{detector_type}'. Válidos: {', '.join(DEFAULT_THRESHOLDS)}")
    server = get_server_owned_by(db, server_id, current_user)
    if not server:
        raise HTTPException(404, f"Servidor {server_id} não encontrado.")

    defaults = DEFAULT_THRESHOLDS[detector_type]
    unknown = set(body.thresholds) - set(defaults)
    if unknown:
        raise HTTPException(422, f"Chaves inválidas para '{detector_type}': {', '.join(sorted(unknown))}")

    row = save_detector_config_overrides(db, server_id, detector_type, body.thresholds)
    effective = dict(defaults)
    effective.update(row.thresholds)
    return {"defaults": defaults, "overrides": row.thresholds, "effective": effective}
