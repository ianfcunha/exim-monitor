"""
Endpoints de segurança por IP — CSF / Imunify360 / MagicSpam.

GET  /api/servers/{id}/security/ip-status?ip=       → status de bloqueio
POST /api/servers/{id}/security/unblock             → desbloqueia (admin only)

MagicSpam não tem endpoint de desbloqueio — o cliente confirmou que já
resolve isso direto no painel dele; entra só como campo informativo em
ip-status (ver diag-exim.sh, _ip_status_magicspam_json).

Mesmo padrão de proteção do execute_action em actions.py: require_admin,
server_cfg resolvido via get_server_owned_by, erros de SSH viram 503.
"""
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..auth import require_admin
from ..crypto import decrypt_secret
from ..database import User, get_db, get_server_owned_by, record_action_history
from ..limiter import limiter
from ..ssh import SSHError, UNBLOCK_TOOLS, check_ip_status, unblock_ip

router = APIRouter(prefix="/api/servers", tags=["security"])


def _server_cfg(db: Session, server_id: int, current_user: User) -> dict:
    server = get_server_owned_by(db, server_id, current_user)
    if not server:
        raise HTTPException(404, f"Servidor {server_id} não encontrado.")
    return {
        "host":                 server.host,
        "port":                 server.port,
        "ssh_user":             server.ssh_user,
        "ssh_auth_type":        server.ssh_auth_type,
        "ssh_secret":           decrypt_secret(server.ssh_secret),
        "script_path":          server.script_path,
        "host_key_fingerprint": server.ssh_host_key_fingerprint,
    }


class UnblockRequest(BaseModel):
    ip: str
    tool: str


@router.get(
    "/{server_id}/security/ip-status",
    summary="Status de bloqueio de um IP em CSF/Imunify360/MagicSpam (admin only)",
)
def get_ip_status(
    server_id: int,
    ip: str = Query(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    server_cfg = _server_cfg(db, server_id, current_user)
    try:
        return check_ip_status(ip, server_cfg=server_cfg)
    except SSHError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@router.post(
    "/{server_id}/security/unblock",
    summary="Desbloqueia um IP em CSF ou Imunify360 (admin only)",
)
@limiter.limit("20/minute")
def post_unblock_ip(
    request: Request,
    server_id: int,
    body: UnblockRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    if body.tool not in UNBLOCK_TOOLS:
        raise HTTPException(
            status_code=422,
            detail=f"Tool '{body.tool}' inválida. Opções: {', '.join(UNBLOCK_TOOLS)}",
        )

    server_cfg = _server_cfg(db, server_id, current_user)
    action = "unblock-ip"
    param = f"{body.tool}:{body.ip}"

    try:
        result = unblock_ip(
            body.ip, body.tool, server_cfg=server_cfg, actor=current_user.username
        )
    except SSHError as exc:
        record_action_history(
            db, server_id=server_id, actor=current_user.username, action=action,
            param=param, success=False, message=str(exc),
        )
        raise HTTPException(status_code=503, detail=str(exc))

    record_action_history(
        db, server_id=server_id, actor=current_user.username, action=action,
        param=param, success=result.get("success", False),
        message=result.get("message"),
    )

    if not result.get("success", False):
        raise HTTPException(
            status_code=422,
            detail=result.get("message", "Ação retornou falha sem mensagem."),
        )

    return result
