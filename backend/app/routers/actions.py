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

Body JSON: { "param": "valor" }  (opcional conforme a ação)
Viewer não pode executar ações.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..auth import require_admin
from ..crypto import decrypt_secret
from ..database import (
    ActionHistory, User, get_db, get_server_owned_by, get_servers_for_user,
    record_action_history, to_utc_iso,
)
from ..limiter import limiter
from ..ssh import SSHError, run_action

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


class ActionRequest(BaseModel):
    param: Optional[str] = None


@router.post("/{action}", summary="Executa ação no servidor EXIM (admin only)")
@limiter.limit("20/minute")
def execute_action(
    request: Request,
    response: Response,
    action: str,
    server_id: Optional[int] = Query(None),
    body: ActionRequest = ActionRequest(),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
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

    # Resolve server_cfg
    server_cfg = None
    if server_id is not None:
        server = get_server_owned_by(db, server_id, current_user)
        if not server:
            raise HTTPException(404, f"Servidor {server_id} não encontrado.")
        server_cfg = {
            "host":                 server.host,
            "port":                 server.port,
            "ssh_user":             server.ssh_user,
            "ssh_auth_type":        server.ssh_auth_type,
            "ssh_secret":           decrypt_secret(server.ssh_secret),
            "script_path":          server.script_path,
            "host_key_fingerprint": server.ssh_host_key_fingerprint,
        }

    try:
        result = run_action(
            action, body.param, server_cfg=server_cfg, actor=current_user.username
        )
    except SSHError as exc:
        record_action_history(
            db, server_id=server_id, actor=current_user.username, action=action,
            param=body.param, success=False, message=str(exc),
        )
        raise HTTPException(status_code=503, detail=str(exc))

    record_action_history(
        db, server_id=server_id, actor=current_user.username, action=action,
        param=body.param, success=result.get("success", False),
        message=result.get("message"),
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
    limit: int = Query(default=100, ge=1, le=500),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """
    Fonte central de auditoria — actor, ação, parâmetro, servidor, sucesso
    e timestamp de cada ação já executada, sem precisar SSH de volta no
    servidor pra ler actions.log em texto.
    """
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

    rows = query.order_by(ActionHistory.executed_at.desc()).limit(limit).all()

    return [
        {
            "id":          r.id,
            "executed_at": to_utc_iso(r.executed_at),
            "server_id":   r.server_id,
            "actor":       r.actor,
            "action":      r.action,
            "param":       r.param,
            "success":     r.success,
            "message":     r.message,
        }
        for r in rows
    ]
