"""
Endpoints de ações sobre o servidor EXIM.

POST /api/actions/{action}

Ações disponíveis:
  clean-full     →  limpa toda a fila
  clean-frozen   →  remove mensagens frozen
  clean-bounces  →  remove bounces (<>)
  clean-sender   →  remove msgs de um remetente  (param: endereço)
  clean-auth     →  remove msgs de um usuário    (param: usuário)
  block-ip       →  bloqueia IP no firewall      (param: IP)
  retry-queue    →  força reprocessamento (exim -qff)

Body JSON: { "param": "valor" }  (opcional conforme a ação)
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..auth import get_current_user
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
    "retry-queue",
})

ACTIONS_REQUIRING_PARAM = frozenset({"clean-sender", "clean-auth", "block-ip"})


class ActionRequest(BaseModel):
    param: Optional[str] = None


@router.post("/{action}", summary="Executa ação no servidor EXIM")
@limiter.limit("20/minute")         # ações SSH — evita flood acidental
def execute_action(
    request: Request,
    action: str,
    body: ActionRequest = ActionRequest(),
    current_user: str = Depends(get_current_user),
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

    try:
        result = run_action(action, body.param)
    except SSHError as exc:
        raise HTTPException(status_code=503, detail=str(exc))

    if not result.get("success", False):
        raise HTTPException(
            status_code=422,
            detail=result.get("message", "Ação retornou falha sem mensagem."),
        )

    return result
