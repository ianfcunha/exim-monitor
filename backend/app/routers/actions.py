"""
Endpoints de ações sobre o servidor EXIM.

POST /api/actions/{action}?server_id=

Ações disponíveis:
  clean-full     →  limpa toda a fila
  clean-frozen   →  remove mensagens frozen
  clean-bounces  →  remove bounces (<>)
  clean-sender   →  remove msgs de um remetente  (param: endereço)
  clean-auth     →  remove msgs de um usuário    (param: usuário)
  block-ip       →  bloqueia IP no firewall      (param: IP)
  block-sender   →  bloqueia sender no EXIM      (param: endereço)
  retry-queue    →  força reprocessamento (exim -qff)
  check-deliverability → blocklists (DNSBL) + SPF/DKIM/DMARC, somente
                    leitura (param: domínio, opcional — sem ele o
                    script tenta detectar a partir do remetente ativo)

Body JSON: { "param": "valor", "snapshot": true }  (snapshot opcional,
default true — captura o estado antes de ações destrutivas; ver
before_snapshot no JSON de resposta e em GET /history)
Viewer não pode executar ações.
"""
import csv
import io
import json
import time
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..auth import get_current_user, require_admin
from ..crypto import SecretDecryptionError
from ..database import (
    ActionHistory, ActionPlan, User, build_server_cfg, get_db,
    get_server_owned_by, get_servers_for_user, record_action_history, to_utc_iso,
)
from ..limiter import limiter
from ..ssh import SSHError, list_quarantine, restore_quarantine, run_action

router = APIRouter(prefix="/api/actions", tags=["actions"])

ALLOWED_ACTIONS = frozenset({
    "clean-full",
    "clean-frozen",
    "clean-bounces",
    "clean-sender",
    "clean-auth",
    "block-ip",
    "block-sender",
    "retry-queue",
    "check-deliverability",
})

ACTIONS_REQUIRING_PARAM = frozenset({
    "clean-sender",
    "clean-auth",
    "block-ip",
    "block-sender",
})

# T3 (Sessão 1, pós-auditoria): toda ação destrutiva exige plan()
# antes de apply() — só check-deliverability é isenta, por ser
# somente-leitura (não faz sentido "planejar" uma consulta).
PLAN_EXEMPT_ACTIONS = frozenset({"check-deliverability"})
PLAN_MAX_AGE_SECONDS = 300  # 5 minutos


class ActionRequest(BaseModel):
    param: Optional[str] = None
    # Captura o estado antes de ações destrutivas (before_snapshot) —
    # exposto como opção pro usuário decidir antes de confirmar a ação
    # (ex.: pular numa fila gigante pra não pagar o custo de listar IDs).
    # Ações não-destrutivas simplesmente ignoram esse campo.
    snapshot: bool = True
    # T3: obrigatório para toda ação fora de PLAN_EXEMPT_ACTIONS — vem
    # de POST /api/actions/{action}/plan, emitido há no máximo
    # PLAN_MAX_AGE_SECONDS.
    plan_id: Optional[str] = None


# ── Rate limit por servidor-alvo (T3) ───────────────────────────────────────
# O @limiter.limit(...) abaixo já limita por IP de origem — mas um único
# admin comprometido (ou token vazado) ainda conseguia disparar N ações
# por minuto contra o MESMO servidor, não importa de quantos IPs. Janela
# deslizante em memória, por processo — suficiente pro deployment
# self-hosted de hoje (um único processo uvicorn); não sobrevive restart
# nem escala pra múltiplos workers, o que é aceitável aqui porque o
# objetivo é conter rajadas acidentais/abuso simples, não ser à prova de
# um atacante sofisticado.
_SERVER_RATE_WINDOW_SECONDS = 60
_SERVER_RATE_MAX_CALLS = 20
_server_action_timestamps: dict = defaultdict(list)


def _check_server_rate_limit(server_id: Optional[int]) -> None:
    key = server_id if server_id is not None else "default"
    now = time.monotonic()
    timestamps = _server_action_timestamps[key]
    cutoff = now - _SERVER_RATE_WINDOW_SECONDS
    while timestamps and timestamps[0] < cutoff:
        timestamps.pop(0)
    if len(timestamps) >= _SERVER_RATE_MAX_CALLS:
        raise HTTPException(
            status_code=429,
            detail=(
                f"Limite de {_SERVER_RATE_MAX_CALLS} ações por "
                f"{_SERVER_RATE_WINDOW_SECONDS}s atingido para este servidor "
                f"(server_id={server_id}) — aguarde antes de tentar de novo."
            ),
        )
    timestamps.append(now)


# ── Score de confiança de domínio (check-deliverability) ────────────────────
# Combina os componentes já estruturados que o script retorna em blocklists/
# spf/dkim/dmarc/cert num único número 0-100 + selo A-F — só pra dar uma
# leitura rápida no dashboard. Pesos arbitrários mas documentados aqui (não
# há fórmula "oficial" de mercado pra isso): blocklist e certificado pesam
# mais porque um domínio limpo mas sem SPF ainda entrega e-mail, enquanto
# estar numa DNSBL ou servir um cert expirado quebra a entrega na hora.
# Mesmo threshold sugerido de EXIM_TH_CERT_DAYS (15 dias) do script — se o
# cliente mudar o threshold lá, pode divergir do usado aqui; não há acoplamento
# automático porque o script não expõe o threshold usado no JSON de retorno.
_CERT_DAYS_WARN_THRESHOLD = 15

_TRUST_SCORE_WEIGHTS = {
    "blocklist": 30,  # nenhuma DNSBL listando o IP
    "spf":       20,
    "dkim":      20,
    "dmarc":     15,
    "cert":      15,  # cert TLS válido e com folga (>= threshold de dias)
}


def _compute_trust_score(result: dict) -> dict:
    """Deriva {"score": 0-100, "grade": "A".."F", "breakdown": {...}} a
    partir do JSON de check-deliverability. Não falha se algum componente
    estiver ausente — trata como reprovado nesse item."""
    breakdown = {}

    blocklists = result.get("blocklists") or []
    blocklist_clean = bool(blocklists) and all(not b.get("listed") for b in blocklists)
    breakdown["blocklist"] = blocklist_clean

    spf_ok   = bool((result.get("spf") or {}).get("found"))
    dkim_ok  = bool((result.get("dkim") or {}).get("found"))
    dmarc_ok = bool((result.get("dmarc") or {}).get("found"))
    breakdown["spf"], breakdown["dkim"], breakdown["dmarc"] = spf_ok, dkim_ok, dmarc_ok

    cert = result.get("cert") or {}
    days_remaining = cert.get("days_remaining")
    cert_ok = bool(cert.get("valid")) and days_remaining is not None and days_remaining >= _CERT_DAYS_WARN_THRESHOLD
    breakdown["cert"] = cert_ok

    score = sum(weight for key, weight in _TRUST_SCORE_WEIGHTS.items() if breakdown.get(key))

    if score >= 90:
        grade = "A"
    elif score >= 75:
        grade = "B"
    elif score >= 60:
        grade = "C"
    elif score >= 40:
        grade = "D"
    else:
        grade = "F"

    return {"score": score, "grade": grade, "breakdown": breakdown}


def _require_admin_logged(db: Session, current_user: User, action: str, server_id: Optional[int]) -> None:
    """
    T8 (Sessão 1, pós-auditoria): "tentativas negadas" fazem parte da
    auditoria pedida — um viewer tentando uma ação destrutiva não pode
    simplesmente sumir num 403 sem deixar rastro. plan_action() e
    execute_action() usam isto no lugar de Depends(require_admin) puro
    (que rejeitaria ANTES do corpo da função rodar, sem chance de
    logar) — a dependency vira Depends(get_current_user) e esta função
    faz a mesma checagem, só que loga antes de recusar.
    """
    if current_user.role == "admin":
        return
    record_action_history(
        db, server_id=server_id, actor=current_user.username, action=action,
        param=None, success=False,
        message="Tentativa negada — usuário não é admin.",
    )
    raise HTTPException(
        status_code=403,
        detail="Apenas administradores podem executar esta ação.",
    )


def _resolve_server_cfg(db: Session, server_id: Optional[int], current_user: User) -> Optional[dict]:
    if server_id is None:
        return None
    server = get_server_owned_by(db, server_id, current_user)
    if not server:
        raise HTTPException(404, f"Servidor {server_id} não encontrado.")
    try:
        return build_server_cfg(server)
    except SecretDecryptionError as exc:
        # T6 (Sessão 1, pós-auditoria): antes decrypt_secret() devolvia
        # "" silenciosamente e a ação falhava com um erro de SSH genérico
        # — o operador não tinha como saber que o problema era a chave de
        # criptografia trocada, não a rede. 503 aqui (não 500) porque é
        # um estado de configuração conhecido, com mensagem acionável.
        server.ssh_status    = "credential_error"
        server.ssh_error_msg = str(exc)[:500]
        db.commit()
        raise HTTPException(503, str(exc)) from exc


@router.post("/{action}/plan", summary="Gera um plano (não altera nada) para uma ação (admin only)")
@limiter.limit("30/minute")
def plan_action(
    request: Request,
    response: Response,
    action: str,
    server_id: Optional[int] = Query(None),
    body: ActionRequest = ActionRequest(),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Fase plan() da Tarefa 3: roda a mesma consulta que apply() usaria
    (diag-exim.sh --dry-run=1), sem alterar nada no servidor, e
    persiste um plan_id de uso único válido por PLAN_MAX_AGE_SECONDS.
    POST /{action} (apply) exige esse plan_id pra qualquer ação fora
    de PLAN_EXEMPT_ACTIONS.
    """
    _require_admin_logged(db, current_user, action, server_id)

    if action not in ALLOWED_ACTIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Ação '{action}' não permitida. Disponíveis: {', '.join(sorted(ALLOWED_ACTIONS))}",
        )
    if action in ACTIONS_REQUIRING_PARAM and not body.param:
        raise HTTPException(422, f"A ação '{action}' requer o campo 'param' no body.")

    server_cfg = _resolve_server_cfg(db, server_id, current_user)

    try:
        result = run_action(
            action, body.param, server_cfg=server_cfg, actor=current_user.username,
            dry_run=True,
        )
    except SSHError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    plan_id = uuid.uuid4().hex
    db.add(ActionPlan(
        id=plan_id, server_id=server_id, actor=current_user.username,
        action=action, param=body.param, preview=result,
    ))
    db.commit()

    return {"plan_id": plan_id, "expires_in_seconds": PLAN_MAX_AGE_SECONDS, "preview": result}


@router.get("/quarantine", summary="Incidentes em quarentena (admin only)")
def get_quarantine_list(
    server_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    server_cfg = _resolve_server_cfg(db, server_id, current_user)
    try:
        result = list_quarantine(server_cfg=server_cfg)
    except SSHError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    return result.get("incidents", [])


@router.post("/quarantine/{incident}/restore", summary="Restaura um incidente da quarentena (admin only)")
@limiter.limit("20/minute")
def post_restore_quarantine(
    request: Request,
    response: Response,
    incident: str,
    server_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    server_cfg = _resolve_server_cfg(db, server_id, current_user)
    try:
        result = restore_quarantine(incident, server_cfg=server_cfg, actor=current_user.username)
    except SSHError as exc:
        record_action_history(
            db, server_id=server_id, actor=current_user.username, action="restore-quarantine",
            param=incident, success=False, message=str(exc),
        )
        raise HTTPException(status_code=503, detail=str(exc))

    record_action_history(
        db, server_id=server_id, actor=current_user.username, action="restore-quarantine",
        param=incident, success=result.get("success", False), message=result.get("message"),
    )
    return result


@router.post("/{action}", summary="Executa ação no servidor EXIM (admin only)")
@limiter.limit("20/minute")
def execute_action(
    request: Request,
    response: Response,
    action: str,
    server_id: Optional[int] = Query(None),
    body: ActionRequest = ActionRequest(),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_admin_logged(db, current_user, action, server_id)

    if action not in ALLOWED_ACTIONS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Ação '{action}' não permitida. "
                f"Disponíveis: {', '.join(sorted(ALLOWED_ACTIONS))}"
            ),
        )

    if action in ACTIONS_REQUIRING_PARAM and not body.param:
        raise HTTPException(
            status_code=422,
            detail=f"A ação '{action}' requer o campo 'param' no body.",
        )

    # T3: rate limit por servidor-alvo — além do @limiter.limit por IP
    # de origem acima, que sozinho não impede um único actor de bater
    # repetidamente no MESMO servidor de vários IPs/tokens.
    try:
        _check_server_rate_limit(server_id)
    except HTTPException:
        # T8: rate limit também é uma tentativa negada — auditável.
        record_action_history(
            db, server_id=server_id, actor=current_user.username, action=action,
            param=body.param, success=False,
            message="Tentativa negada — limite de ações por servidor excedido.",
        )
        raise

    # T3: plan()/apply() — toda ação fora de PLAN_EXEMPT_ACTIONS exige
    # um plan_id gerado nos últimos PLAN_MAX_AGE_SECONDS, correspondente
    # exatamente a esta ação/servidor/parâmetro, e ainda não consumido.
    if action not in PLAN_EXEMPT_ACTIONS:
        def _deny_plan(status_code: int, detail: str):
            record_action_history(
                db, server_id=server_id, actor=current_user.username, action=action,
                param=body.param, success=False, message=f"Tentativa negada — {detail}",
                plan_id=body.plan_id,
            )
            raise HTTPException(status_code, detail)

        if not body.plan_id:
            _deny_plan(422, f"A ação '{action}' requer um plan_id — gere um plano primeiro em POST /api/actions/{action}/plan.")
        plan = db.get(ActionPlan, body.plan_id)
        if not plan:
            _deny_plan(404, f"Plano '{body.plan_id}' não encontrado.")
        if plan.consumed_at is not None:
            _deny_plan(409, "Este plano já foi aplicado — gere um novo.")
        if plan.action != action or plan.server_id != server_id or (plan.param or None) != (body.param or None):
            _deny_plan(409, "O plano não corresponde exatamente a esta ação/servidor/parâmetro — gere um novo plano.")
        age_seconds = (datetime.utcnow() - plan.created_at).total_seconds()
        if age_seconds > PLAN_MAX_AGE_SECONDS:
            _deny_plan(409, f"Plano expirado ({int(age_seconds)}s atrás, máximo {PLAN_MAX_AGE_SECONDS}s) — gere um novo.")
        plan.consumed_at = datetime.utcnow()
        db.commit()

    server_cfg = _resolve_server_cfg(db, server_id, current_user)

    try:
        result = run_action(
            action, body.param, server_cfg=server_cfg, actor=current_user.username,
            snapshot=body.snapshot, incident=body.plan_id,
        )
    except SSHError as exc:
        record_action_history(
            db, server_id=server_id, actor=current_user.username, action=action,
            param=body.param, success=False, message=str(exc), plan_id=body.plan_id,
        )
        raise HTTPException(status_code=503, detail=str(exc))

    if action == "check-deliverability" and result.get("success", False):
        result["trust_score"] = _compute_trust_score(result)

    # before_snapshot (estado antes de ações destrutivas — clean-*/block-*)
    # não tem coluna própria em ActionHistory; vai anexado ao `message`
    # (por isso essa coluna virou TEXT na migration 009 — varchar(500) não
    # sobraria espaço pra amostra de IDs + mensagem). Só o histórico
    # persistido carrega isso — a resposta HTTP já devolve before_snapshot
    # como campo estruturado separado, sem precisar reparsear o texto.
    history_message = result.get("message")
    before_snapshot = result.get("before_snapshot")
    if before_snapshot:
        history_message = (
            f"{history_message}\n\n--- Estado antes da ação ---\n"
            f"{json.dumps(before_snapshot, ensure_ascii=False, indent=2)}"
        )

    # T8 (Sessão 1, pós-auditoria): "como reverter" — dica curta e
    # estruturada, não só o before_snapshot em texto livre. Ações
    # quarentenadas (clean-*) apontam pro próprio incidente de restore;
    # block-ip aponta pro unblock; block-sender ainda não tem reversão
    # de um clique (Tarefa 2 não cobriu isso), fica documentado como tal.
    revert_hint = None
    if result.get("quarantine_incident"):
        revert_hint = f"restore-quarantine:{result['quarantine_incident']}"
    elif action == "block-ip" and body.param:
        revert_hint = f"unblock-ip:{body.param}"
    elif action == "block-sender" and body.param:
        revert_hint = "sem reversão de um clique — editar /etc/exim4/spammer_sender manualmente"

    record_action_history(
        db, server_id=server_id, actor=current_user.username, action=action,
        param=body.param, success=result.get("success", False),
        message=history_message, plan_id=body.plan_id, revert_hint=revert_hint,
    )

    if not result.get("success", False):
        raise HTTPException(
            status_code=422,
            detail=result.get("message", "Ação retornou falha sem mensagem."),
        )

    return result


@router.get("/history", summary="Histórico de ações executadas (admin only)")
def get_action_history(
    server_id: Optional[int] = Query(None),
    start: Optional[date] = Query(None, description="Data inicial (YYYY-MM-DD), inclusive"),
    end: Optional[date] = Query(None, description="Data final (YYYY-MM-DD), inclusive"),
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """
    Fonte central de auditoria — quem, quando, o plano usado, o resultado
    real e como reverter (T8, Sessão 1, pós-auditoria) — sem precisar SSH
    de volta no servidor pra ler actions.log em texto. Inclui tentativas
    negadas (permissão insuficiente, rate limit, plano inválido) e falhas
    de conexão, não só execuções bem-sucedidas.
    """
    rows = _query_action_history(db, current_user, server_id, start, end).limit(limit).all()
    return [_history_row_to_dict(r) for r in rows]


def _query_action_history(
    db: Session, current_user: User, server_id: Optional[int],
    start: Optional[date], end: Optional[date],
):
    if server_id is not None:
        server = get_server_owned_by(db, server_id, current_user)
        if not server:
            raise HTTPException(404, f"Servidor {server_id} não encontrado.")
        visible_ids = [server_id]
    else:
        # Sem server_id: escopo por padrão aos servidores visíveis ao
        # usuário (mesma regra de get_servers_for_user) — sem isso, um
        # admin veria o histórico de ações de outros admins/clientes.
        visible_ids = [s.id for s in get_servers_for_user(db, current_user)]

    query = db.query(ActionHistory).filter(ActionHistory.server_id.in_(visible_ids))
    if start is not None:
        query = query.filter(ActionHistory.executed_at >= datetime.combine(start, datetime.min.time()))
    if end is not None:
        query = query.filter(ActionHistory.executed_at < datetime.combine(end, datetime.min.time()) + timedelta(days=1))
    return query.order_by(ActionHistory.executed_at.desc())


def _history_row_to_dict(r: ActionHistory) -> dict:
    return {
        "id":          r.id,
        "executed_at": to_utc_iso(r.executed_at),
        "server_id":   r.server_id,
        "actor":       r.actor,
        "action":      r.action,
        "param":       r.param,
        "success":     r.success,
        "message":     r.message,
        "plan_id":     r.plan_id,
        "revert_hint": r.revert_hint,
    }


@router.get("/history/export", summary="Exporta o histórico de ações (CSV ou JSON, admin only)")
def export_action_history(
    server_id: Optional[int] = Query(None),
    start: Optional[date] = Query(None, description="Data inicial (YYYY-MM-DD), inclusive"),
    end: Optional[date] = Query(None, description="Data final (YYYY-MM-DD), inclusive"),
    format: str = Query("csv", pattern="^(csv|json)$"),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """
    T8 (Sessão 1, pós-auditoria): exportação por período e por servidor —
    sem hash encadeado nesta fase (decisão explícita: nenhum piloto pediu
    prova de inviolabilidade ainda; volta se um cliente pedir).
    """
    rows = _query_action_history(db, current_user, server_id, start, end).limit(10_000).all()
    entries = [_history_row_to_dict(r) for r in rows]

    period = f"_{start.isoformat()}_{end.isoformat()}" if (start or end) else ""
    server_part = f"_server{server_id}" if server_id is not None else ""
    filename_base = f"mailiq-action-history{server_part}{period}"

    if format == "json":
        body = json.dumps(entries, ensure_ascii=False, indent=2)
        media_type = "application/json"
        filename = f"{filename_base}.json"
    else:
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow([
            "id", "executed_at", "server_id", "actor", "action", "param",
            "success", "plan_id", "revert_hint", "message",
        ])
        for e in entries:
            writer.writerow([
                e["id"], e["executed_at"], e["server_id"], e["actor"], e["action"],
                e["param"], e["success"], e["plan_id"], e["revert_hint"], e["message"],
            ])
        body = buf.getvalue()
        media_type = "text/csv"
        filename = f"{filename_base}.csv"

    return Response(
        content=body,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
