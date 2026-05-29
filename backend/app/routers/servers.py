"""
CRUD de servidores EXIM.

GET    /api/servers              → lista servidores do usuário
POST   /api/servers              → adiciona servidor (admin only)
GET    /api/servers/{id}         → detalhe do servidor
PUT    /api/servers/{id}         → edita servidor (admin only)
DELETE /api/servers/{id}         → remove servidor (admin only)
POST   /api/servers/{id}/test    → testa conexão SSH (admin only)
GET    /api/servers/{id}/ssh-status → status SSH atual do servidor
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..auth import get_current_user, require_admin
from ..crypto import decrypt_secret, encrypt_secret
from ..database import Server, User, get_db, get_server_owned_by, get_servers_for_user
from ..limiter import limiter

router = APIRouter(prefix="/api/servers", tags=["servers"])

MASK = "••••••••"


# ── Schemas ────────────────────────────────────────────────────────────────

class ServerCreate(BaseModel):
    name:          str = Field(..., min_length=1, max_length=100)
    host:          str = Field(..., min_length=1, max_length=255)
    port:          int = Field(22, ge=1, le=65535)
    ssh_user:      str = Field("root", max_length=100)
    ssh_auth_type: str = Field("password", pattern="^(password|key)$")
    ssh_secret:    str = Field("", description="Senha SSH ou conteúdo da chave privada — nunca preenchido automaticamente")
    script_path:   str = Field("/root/diag-exim.sh", max_length=500)


class ServerUpdate(BaseModel):
    name:          Optional[str] = Field(None, min_length=1, max_length=100)
    host:          Optional[str] = Field(None, min_length=1, max_length=255)
    port:          Optional[int] = Field(None, ge=1, le=65535)
    ssh_user:      Optional[str] = Field(None, max_length=100)
    ssh_auth_type: Optional[str] = Field(None, pattern="^(password|key)$")
    ssh_secret:    Optional[str] = Field(None, description="Novo segredo — deixe vazio para manter o atual")
    script_path:   Optional[str] = Field(None, max_length=500)
    is_enabled:    Optional[bool] = None


def _to_response(s: Server, include_secret: bool = False) -> dict:
    return {
        "id":               s.id,
        "name":             s.name,
        "host":             s.host,
        "port":             s.port,
        "ssh_user":         s.ssh_user,
        "ssh_auth_type":    s.ssh_auth_type,
        "ssh_secret":       MASK if s.ssh_secret else "",  # nunca expõe o segredo real
        "script_path":      s.script_path,
        "is_enabled":       s.is_enabled,
        "ssh_status":       s.ssh_status,
        "ssh_error_msg":    s.ssh_error_msg,
        "last_connected_at": s.last_connected_at.isoformat() if s.last_connected_at else None,
        "created_at":       s.created_at.isoformat() if s.created_at else None,
    }


def _build_server_cfg(s: Server) -> dict:
    """Monta dict de configuração SSH para passar ao ssh.py."""
    return {
        "host":          s.host,
        "port":          s.port,
        "ssh_user":      s.ssh_user,
        "ssh_auth_type": s.ssh_auth_type,
        "ssh_secret":    decrypt_secret(s.ssh_secret),
        "script_path":   s.script_path,
    }


# ── Endpoints ──────────────────────────────────────────────────────────────

@router.get("", summary="Listar servidores do usuário")
def list_servers(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    servers = get_servers_for_user(db, current_user)
    return [_to_response(s) for s in servers]


@router.post("", summary="Adicionar servidor (admin only)")
def create_server(
    payload: ServerCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    encrypted = encrypt_secret(payload.ssh_secret) if payload.ssh_secret else ""
    server = Server(
        owner_id      = current_user.id,
        name          = payload.name,
        host          = payload.host,
        port          = payload.port,
        ssh_user      = payload.ssh_user,
        ssh_auth_type = payload.ssh_auth_type,
        ssh_secret    = encrypted,
        script_path   = payload.script_path,
        is_enabled    = True,
        ssh_status    = "unknown",
    )
    db.add(server)
    db.commit()
    db.refresh(server)
    return _to_response(server)


@router.get("/{server_id}", summary="Detalhe do servidor")
def get_server(
    server_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    server = get_server_owned_by(db, server_id, current_user)
    if not server:
        raise HTTPException(404, "Servidor não encontrado.")
    return _to_response(server)


@router.put("/{server_id}", summary="Editar servidor (admin only)")
def update_server(
    server_id: int,
    payload: ServerUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    server = get_server_owned_by(db, server_id, current_user)
    if not server:
        raise HTTPException(404, "Servidor não encontrado.")

    if payload.name          is not None: server.name          = payload.name
    if payload.host          is not None: server.host          = payload.host
    if payload.port          is not None: server.port          = payload.port
    if payload.ssh_user      is not None: server.ssh_user      = payload.ssh_user
    if payload.ssh_auth_type is not None: server.ssh_auth_type = payload.ssh_auth_type
    if payload.script_path   is not None: server.script_path   = payload.script_path
    if payload.is_enabled    is not None: server.is_enabled    = payload.is_enabled

    # Só atualiza o segredo se vier preenchido e diferente da máscara
    if payload.ssh_secret and payload.ssh_secret != MASK:
        server.ssh_secret = encrypt_secret(payload.ssh_secret)

    db.commit()
    db.refresh(server)
    return _to_response(server)


@router.delete("/{server_id}", summary="Remover servidor (admin only)")
def delete_server(
    server_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    server = get_server_owned_by(db, server_id, current_user)
    if not server:
        raise HTTPException(404, "Servidor não encontrado.")

    db.delete(server)
    db.commit()
    return {"ok": True}


@router.post("/{server_id}/test", summary="Testar conexão SSH (admin only)")
@limiter.limit("10/minute")
def test_server(
    request: Request,
    response: Response,
    server_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    from datetime import datetime
    from ..ssh import SSHError, test_connection

    server = get_server_owned_by(db, server_id, current_user)
    if not server:
        raise HTTPException(404, "Servidor não encontrado.")

    cfg = _build_server_cfg(server)
    try:
        latency_ms = test_connection(cfg)
        server.ssh_status       = "ok"
        server.ssh_error_msg    = None
        server.last_connected_at = datetime.utcnow()
        db.commit()
        return {"ok": True, "latency_ms": latency_ms, "status": "ok"}
    except SSHError as exc:
        server.ssh_status    = "error"
        server.ssh_error_msg = str(exc)[:500]
        db.commit()
        return {"ok": False, "status": "error", "error": str(exc)}


@router.get("/{server_id}/ssh-status", summary="Status SSH atual do servidor")
def ssh_status(
    server_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    server = get_server_owned_by(db, server_id, current_user)
    if not server:
        raise HTTPException(404, "Servidor não encontrado.")
    return {
        "server_id":        server.id,
        "ssh_status":       server.ssh_status,
        "ssh_error_msg":    server.ssh_error_msg,
        "last_connected_at": server.last_connected_at.isoformat() if server.last_connected_at else None,
    }
