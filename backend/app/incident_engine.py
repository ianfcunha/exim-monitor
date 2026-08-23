"""
Motor de incidentes: chamado por collector.py a cada ciclo full, depois
de salvar o snapshot e amostrar baseline. Orquestra os 4 detectores +
baseline + máquina de estados explícita (Incident/IncidentEvent) +
notificação — nenhuma dessas peças sabe da existência das outras; este
módulo é o único que as conecta.

Máquina de estados (por fingerprint = tipo+subtipo+servidor+entidade):
  aberto         → detector encontrou a fingerprint em N leituras
                    consecutivas (ver HYSTERESIS)
  em_observacao  → detector NÃO encontrou mais, mas ainda não bateu M
                    leituras limpas seguidas (reaparecer volta pra
                    "aberto", evento "reopened" — não notifica: não é
                    abertura nem agravamento novo)
  mitigado       → setado por fora (routers/incidents.py, fix/apply) —
                    este módulo nunca escreve "mitigado"
  resolvido      → M leituras limpas seguidas (resolution="automatica")
                    ou resolução manual (fora daqui)

Agravamento: mesma fingerprint, `triggered_by.observed` numérico maior
que o do incidente já aberto — NÃO cria incidente novo, adiciona evento
"escalated" ao existente.

── Sessão 4 ──────────────────────────────────────────────────────────

Tarefa 1: toda checagem é persistida (CheckResult), inclusive as que
passaram e as que não puderam ser feitas. Uma checagem "desconhecida"
nunca abre incidente E nunca conta como ciclo limpo — um incidente
aberto não é resolvido automaticamente com base em leituras que não
conseguimos fazer.

Tarefa 3: nenhuma transição de estado a partir de uma única amostra.
Abrir exige N leituras positivas consecutivas, fechar exige M negativas
consecutivas, e um incidente resolvido não reabre dentro de
COOLDOWN_MINUTES sem mudança material. O histórico do INC-59 mostrava a
mesma blocklist entrando e saindo doze vezes em doze horas — sem
histerese, cada consulta com falha intermitente virava uma transição (e,
com Telegram ligado, uma mensagem).

Tarefa 7: a evidência é montada por tipo. Linhas de log só fazem sentido
para conta comprometida e fila travada; para reputação a evidência é a
zona consultada, a resposta bruta, o resolver e o histórico das últimas
checagens — que nunca estariam no mainlog.
"""
import logging
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

from .baseline import make_baseline_fn
from .database import (
    Incident, Snapshot, get_check_history, get_detector_config_overrides,
    record_check_result, record_incident_event,
)
from .incident_impact import freeze_impact
from .detectors import (
    STATUS_ALERTA, STATUS_CRITICO, STATUS_DESCONHECIDO, Candidate, CheckOutcome,
    detect_auth_abuse, detect_dest_deferral, detect_queue_stuck, detect_reputation,
    make_fingerprint,
)
from .incident_notify import notify_incident_event
from .ssh import SSHError, get_log_entries, run_action

logger = logging.getLogger(__name__)

RESOLVE_AFTER_CLEAN_CYCLES = 3
# Cobre o maior "consecutive_cycles"/"frozen_consecutive_cycles" possível
# entre os thresholds padrão E qualquer override razoável — folga de
# segurança, não um valor mágico ajustado a um único threshold.
QUEUE_SNAPSHOT_LOOKBACK = 10

# Histerese por checagem: (leituras positivas para ABRIR, leituras
# limpas para FECHAR). O padrão já não abre com uma amostra só.
#
# A blocklist é o caso mais sensível e por isso o mais rígido: consultas
# DNSBL falham de forma intermitente por natureza (recusa do resolver,
# timeout, cota), e cada falha lida como transição vira notificação.
# Fechar exige mais leituras do que abrir de propósito — sair de uma
# blocklist é lento e irregular, e anunciar "resolvido" cedo demais é
# pior do que demorar um ciclo a mais.
HYSTERESIS: Dict[str, Tuple[int, int]] = {
    "reputation.blocklist": (3, 5),
    "reputation.cert": (2, 2),
    "reputation.dns_auth": (2, 2),
}
_DEFAULT_HYSTERESIS = (2, RESOLVE_AFTER_CLEAN_CYCLES)

# Um incidente resolvido não pode reabrir dentro desta janela sem
# mudança material (métrica pior que a do fechamento). Sem isto, uma
# consulta oscilante reabre o mesmo incidente minutos depois de fechá-lo
# — o padrão exato do histórico do INC-59.
COOLDOWN_MINUTES = 90

_EVIDENCE_LINES_LIMIT = 10
_EVIDENCE_HISTORY_LIMIT = 12

_POSITIVE_STATUSES = (STATUS_CRITICO, STATUS_ALERTA)


def candidate_check_key(type_: str, subtype: str) -> str:
    """A checagem que sustenta um candidato. `reputation` tem três
    subcheagens independentes (blocklist/dns_auth/cert) e cada uma tem
    a própria histerese; os demais tipos têm uma só."""
    if type_ == "reputation" and subtype:
        return f"{type_}.{subtype}"
    return type_


# ── Evidência por tipo (Tarefa 7) ───────────────────────────────────────

def _log_evidence(server_cfg: Optional[Dict[str, Any]], hint: Dict[str, Any]) -> Dict[str, Any]:
    """
    Linhas reais do mainlog que sustentam o diagnóstico. Best-effort:
    falha aqui não pode impedir o incidente de ser registrado — mas o
    motivo da ausência é específico, nunca um genérico que sugere falha
    de coleta quando o log simplesmente não é a fonte certa.
    """
    if not server_cfg:
        return {"kind": "log_lines", "lines": [],
                "unavailable_reason": "sem conexão SSH com o servidor no momento da abertura — "
                                      "as linhas de log não puderam ser lidas"}
    try:
        entries = get_log_entries(hint["log_filter"], limit=300, server_cfg=server_cfg)
    except SSHError as exc:
        logger.debug("Falha ao buscar evidência (%s): %s", hint, exc)
        return {"kind": "log_lines", "lines": [],
                "unavailable_reason": f"a leitura do mainlog falhou: {exc}"}

    match = hint.get("match") or ""
    total = len(entries)
    if match:
        entries = [e for e in entries if match in e.get("raw", "")]
    lines = [e["raw"] for e in entries[:_EVIDENCE_LINES_LIMIT]]
    if lines:
        return {"kind": "log_lines", "lines": lines, "log_filter": hint.get("log_filter"), "match": match}
    return {
        "kind": "log_lines", "lines": [], "log_filter": hint.get("log_filter"), "match": match,
        "unavailable_reason": (
            f"nenhuma das {total} linhas recentes de '{hint.get('log_filter')}' menciona "
            f"'{match}' — o evento pode ter saído da janela de log lida"
            if match else
            f"não há linhas recentes do tipo '{hint.get('log_filter')}' no mainlog"
        ),
    }


def _build_evidence(db, server_id: int, server_cfg: Optional[Dict[str, Any]],
                    hint: Dict[str, Any]) -> Dict[str, Any]:
    kind = (hint or {}).get("kind")

    if kind == "log_lines":
        return _log_evidence(server_cfg, hint)

    if kind == "dnsbl":
        history = get_check_history(db, server_id, "reputation.blocklist", _EVIDENCE_HISTORY_LIMIT)
        return {
            "kind": "dnsbl",
            "ip": hint.get("ip"),
            "resolver": hint.get("resolver"),
            "zones": hint.get("zones") or [],
            "history": [
                {"at": h.observed_at.isoformat() + "Z", "status": h.status, "reason": h.reason,
                 "zones": ((h.detail or {}).get("zones") or [])}
                for h in history
            ],
        }

    if kind == "dns_auth":
        return {"kind": "dns_auth", "domain": hint.get("domain"), "records": hint.get("records") or {}}

    if kind == "cert":
        return {"kind": "cert", **{k: v for k, v in hint.items() if k != "kind"}}

    return {"kind": "none",
            "unavailable_reason": "este tipo de incidente não define uma fonte de evidência"}


# ── Histerese e cooldown (Tarefa 3) ─────────────────────────────────────

def _consecutive_positive(db, server_id: int, check_key: str, needed: int) -> int:
    """
    Quantas leituras positivas consecutivas existem, da mais recente para
    trás. Leituras "desconhecidas" são PULADAS, não contadas como
    negativas: uma consulta que não pôde ser feita não é prova de que o
    problema sumiu — tratá-la como negativa reintroduziria o flapping por
    outra porta.
    """
    rows = get_check_history(db, server_id, check_key, max(needed * 3, _EVIDENCE_HISTORY_LIMIT))
    count = 0
    for row in rows:
        if row.status == STATUS_DESCONHECIDO:
            continue
        if row.status in _POSITIVE_STATUSES:
            count += 1
            if count >= needed:
                return count
        else:
            break
    return count


def _cooldown_blocks(db, server_id: int, fingerprint: str, now: datetime,
                     candidate: Candidate) -> Optional[str]:
    """
    Devolve o motivo do bloqueio se este fingerprint foi resolvido há
    menos de COOLDOWN_MINUTES e não houve mudança material; None se pode
    abrir. "Mudança material" = métrica observada pior que a do
    fechamento — o mesmo comparador do agravamento, para não existirem
    duas definições de "piorou" no sistema.
    """
    recent = (
        db.query(Incident)
        .filter(
            Incident.server_id == server_id,
            Incident.fingerprint == fingerprint,
            Incident.status == "resolvido",
            Incident.resolved_at >= now - timedelta(minutes=COOLDOWN_MINUTES),
        )
        .order_by(Incident.resolved_at.desc())
        .first()
    )
    if recent is None:
        return None
    if _is_worse(recent.triggered_by, candidate["triggered_by"]):
        return None
    minutes = int((now - recent.resolved_at).total_seconds() // 60)
    return (f"{recent.display_id} foi resolvido há {minutes}min com a mesma causa e a "
            f"métrica não piorou — reabertura suprimida por {COOLDOWN_MINUTES}min")


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
    checks: List[CheckOutcome] = []
    for cand_list, check_list in (
        detect_auth_abuse(data, get_detector_config_overrides(db, server_id, "auth_abuse"), baseline_fn),
        detect_reputation(deliverability, data, get_detector_config_overrides(db, server_id, "reputation")),
        detect_queue_stuck(recent_full, data, get_detector_config_overrides(db, server_id, "queue_stuck"), baseline_fn),
        detect_dest_deferral(data, get_detector_config_overrides(db, server_id, "dest_deferral")),
    ):
        candidates += cand_list
        checks += check_list

    # As checagens deste ciclo são gravadas ANTES de qualquer decisão de
    # estado — a histerese abaixo lê o histórico incluindo esta leitura.
    for outcome in checks:
        record_check_result(db, server_id, outcome)
    db.commit()

    status_by_key = {c["key"]: c["status"] for c in checks}

    candidates_by_fp: Dict[str, Candidate] = {
        make_fingerprint(c["type"], c["subtype"], server_id, c["entity"]): c for c in candidates
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
        check_key = candidate_check_key(incident.type, incident.subtype or "")
        _, close_after = HYSTERESIS.get(check_key, _DEFAULT_HYSTERESIS)

        if cand is None:
            # Uma checagem que não pôde ser feita não é prova de que o
            # problema acabou — não avança o contador de fechamento, e o
            # incidente passa a exibir "não foi possível reverificar
            # desde X" em vez de continuar afirmando que está confirmado.
            if status_by_key.get(check_key) == STATUS_DESCONHECIDO:
                if incident.unverified_since is None:
                    incident.unverified_since = now
                    record_incident_event(db, incident, "unverified", actor="system",
                                          detail={"check": check_key})
                db.commit()
                continue

            incident.unverified_since = None
            incident.consecutive_clean += 1
            if incident.consecutive_clean >= close_after:
                incident.status = "resolvido"
                incident.resolved_at = now
                incident.resolution = "automatica"
                freeze_impact(db, incident)
                record_incident_event(db, incident, "resolved", actor="system",
                                      detail={"consecutive_clean": incident.consecutive_clean,
                                              "close_after": close_after})
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
        incident.severity = cand["severity"]
        incident.consecutive_clean = 0
        incident.unverified_since = None
        if incident.status == "em_observacao":
            incident.status = "aberto"
        elif incident.status == "mitigado" and worse:
            # A correção aplicada não segurou — volta a "aberto" (não é
            # silenciosamente ignorado como "mitigado" para sempre).
            incident.status = "aberto"

        if worse:
            incident.evidence = _build_evidence(db, server_id, server_cfg, cand["evidence_hint"])
            record_incident_event(db, incident, "escalated", actor="system", detail={"metrics": cand["metrics"]})
            db.commit()
            notify_incident_event(incident, "escalated")
        elif was_observacao:
            # Reapareceu sem agravar — real, mas não é abertura nem
            # agravamento; registra sem notificar.
            record_incident_event(db, incident, "reopened", actor="system")
            db.commit()
        else:
            db.commit()

    # ── 2) candidatos novos (sem incidente aberto correspondente) ──
    for fp, cand in candidates_by_fp.items():
        if fp in open_by_fp:
            continue

        check_key = candidate_check_key(cand["type"], cand["subtype"])
        open_after, _ = HYSTERESIS.get(check_key, _DEFAULT_HYSTERESIS)
        seen = _consecutive_positive(db, server_id, check_key, open_after)
        if seen < open_after:
            logger.info(
                "Candidato %s ainda em confirmação (%d/%d leituras positivas) — nenhum incidente aberto",
                fp, seen, open_after,
            )
            continue

        blocked = _cooldown_blocks(db, server_id, fp, now, cand)
        if blocked:
            logger.info("Abertura de %s suprimida por cooldown: %s", fp, blocked)
            continue

        evidence = _build_evidence(db, server_id, server_cfg, cand["evidence_hint"])
        incident = Incident(
            server_id=server_id, type=cand["type"], subtype=cand["subtype"],
            severity=cand["severity"], status="aberto",
            fingerprint=fp, entity=cand["entity"], first_seen=now, last_seen=now,
            evidence=evidence,
            metrics=cand["metrics"], suggested_fix=cand["suggested_fix"], triggered_by=cand["triggered_by"],
        )
        db.add(incident)
        db.commit()
        db.refresh(incident)
        record_incident_event(db, incident, "opened", actor="system",
                              detail={"confirmations": seen, "open_after": open_after})
        db.commit()
        notify_incident_event(incident, "opened")


def run_incident_cycle(db_factory, server_id: int, data: Dict[str, Any],
                       server_cfg: Optional[Dict[str, Any]]) -> None:
    """
    Wrapper síncrono chamado por collector.py via asyncio.to_thread
    (tudo aqui dentro é I/O bloqueante: SSH + Postgres). Busca
    check-deliverability e chama evaluate_incidents() numa sessão
    própria. Se a checagem falhar, `deliverability` fica None — e o
    detector de reputação devolve "desconhecido" com o motivo, não uma
    ausência de problema (Tarefa 1).
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
