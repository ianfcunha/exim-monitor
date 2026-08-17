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

Body JSON: { "param": "valor" }  (opcional conforme a ação)
Viewer não pode executar ações.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..auth import require_admin
from ..crypto import decrypt_secret
from ..database import User, get_db, get_server_owned_by
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
        result = run_action(action, body.param, server_cfg=server_cfg)
    except SSHError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    if not result.get("success", False):
        raise HTTPException(
            status_code=422,
            detail=result.get("message", "Ação retornou falha sem mensagem."),
        )

    return result
