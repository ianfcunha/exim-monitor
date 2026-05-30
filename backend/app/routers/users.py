"""
Gestão de usuários — convites e listagem.

POST /api/users/invite              → admin envia convite por e-mail
GET  /api/users/accept/{token}      → verifica token e retorna dados para setup
POST /api/users/accept/{token}      → convidado define username+senha e ativa conta
GET  /api/users                     → lista membros (admin only)
POST /api/users/{id}/resend-invite  → reenvia convite e renova o token (admin only)
GET  /api/users/{id}/invite-link    → retorna o link do convite pendente (admin only)
DELETE /api/users/{id}              → remove membro (admin only)
"""
import secrets
from datetime import datetime, timedelta
from typing import Optional

import resend
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from ..auth import get_current_user, hash_password, require_admin
from ..config import settings
from ..database import User, get_db, get_user_by_email
from ..limiter import limiter

router = APIRouter(prefix="/api/users", tags=["users"])

INVITE_EXPIRE_HOURS = 72


# ── Schemas ────────────────────────────────────────────────────────────────

class InviteRequest(BaseModel):
    email: EmailStr
    role: str = Field("viewer", pattern="^(admin|viewer)$")


class AcceptInviteRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=50)
    password: str = Field(..., min_length=8)


# ── Helpers ────────────────────────────────────────────────────────────────

def _send_invite_email(to_email: str, inviter_username: str, token: str) -> None:
    """Envia e-mail de convite via Resend."""
    if not settings.resend_api_key:
        raise RuntimeError("RESEND_API_KEY não configurada — não é possível enviar convites.")

    resend.api_key = settings.resend_api_key
    accept_url = f"{settings.app_url}/invite/{token}"

    html = f"""
<!DOCTYPE html><html><body style="font-family:sans-serif;background:#f8fafc;margin:0;padding:24px">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;
            border:1px solid #e2e8f0;overflow:hidden">
  <div style="background:#0F172A;padding:20px 28px">
    <span style="color:#fff;font-size:18px;font-weight:800">Mail <span style="color:#0EA5E9">IQ</span></span>
    <span style="color:#94A3B8;font-size:11px;margin-left:8px">by AVILI</span>
  </div>
  <div style="padding:28px">
    <p style="color:#0F172A;font-size:15px;margin:0 0 16px">
      <strong>{inviter_username}</strong> convidou você para acessar o <strong>Mail IQ</strong>.
    </p>
    <a href="{accept_url}"
       style="display:inline-block;background:#0EA5E9;color:#fff;text-decoration:none;
              padding:12px 24px;border-radius:8px;font-weight:700;font-size:14px">
      Aceitar convite
    </a>
    <p style="margin:20px 0 0;color:#94A3B8;font-size:12px">
      Este link expira em {INVITE_EXPIRE_HOURS} horas.<br>
      Se você não esperava este convite, ignore este e-mail.
    </p>
  </div>
</div>
</body></html>"""

    resend.Emails.send({
        "from":    settings.resend_from,
        "to":      [to_email],
        "subject": f"Convite para Mail IQ — {inviter_username} quer que você colabore",
        "html":    html,
    })


# ── Endpoints ──────────────────────────────────────────────────────────────

@router.post("/invite", summary="Convidar novo usuário por e-mail")
@limiter.limit("10/minute")
def invite_user(
    request: Request,
    response: Response,
    payload: InviteRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    if get_user_by_email(db, payload.email):
        raise HTTPException(400, "Já existe uma conta com este e-mail.")

    token   = secrets.token_urlsafe(32)
    expires = datetime.utcnow() + timedelta(hours=INVITE_EXPIRE_HOURS)

    invited = User(
        email             = payload.email,
        username          = payload.email,   # placeholder — será definido no accept
        role              = payload.role,
        is_active         = False,
        email_verified    = False,
        invite_token      = token,
        invite_expires_at = expires,
        invited_by        = current_user.id if current_user.id != 0 else None,
        created_at        = datetime.utcnow(),
    )
    db.add(invited)
    db.commit()

    try:
        _send_invite_email(payload.email, current_user.username, token)
    except Exception as exc:
        # Não falha o endpoint — loga e retorna aviso
        import logging
        logging.getLogger(__name__).error("Falha ao enviar e-mail de convite: %s", exc)
        return {
            "ok": False,
            "message": f"Convite criado, mas falha ao enviar e-mail: {exc}",
            "invite_url": f"{settings.app_url}/invite/{token}",
        }

    return {"ok": True, "message": f"Convite enviado para {payload.email}."}


@router.get("/accept/{token}", summary="Verifica token de convite")
def check_invite(token: str, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.invite_token == token).first()
    if not user:
        raise HTTPException(404, "Token de convite inválido.")
    if user.invite_expires_at and datetime.utcnow() > user.invite_expires_at:
        raise HTTPException(410, "Este convite expirou.")
    return {"email": user.email, "role": user.role}


@router.post("/accept/{token}", summary="Ativar conta via convite")
def accept_invite(
    token: str,
    payload: AcceptInviteRequest,
    db: Session = Depends(get_db),
):
    user = db.query(User).filter(User.invite_token == token).first()
    if not user:
        raise HTTPException(404, "Token de convite inválido.")
    if user.invite_expires_at and datetime.utcnow() > user.invite_expires_at:
        raise HTTPException(410, "Este convite expirou.")

    # Verifica username único
    existing = db.query(User).filter(
        User.username == payload.username,
        User.id != user.id,
    ).first()
    if existing:
        raise HTTPException(409, "Este nome de usuário já está em uso.")

    user.username          = payload.username
    user.password_hash     = hash_password(payload.password)
    user.is_active         = True
    user.email_verified    = True
    user.invite_token      = None
    user.invite_expires_at = None
    db.commit()

    return {"ok": True, "message": "Conta ativada com sucesso. Faça login para continuar."}


@router.get("", summary="Listar usuários (admin only)")
def list_users(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    users = db.query(User).all()
    return [
        {
            "id":             u.id,
            "email":          u.email,
            "username":       u.username,
            "role":           u.role,
            "is_active":      u.is_active,
            "email_verified": u.email_verified,
            "invite_pending": bool(u.invite_token),
            "created_at":     u.created_at.isoformat() if u.created_at else None,
            "last_login_at":  u.last_login_at.isoformat() if u.last_login_at else None,
        }
        for u in users
    ]


@router.post("/{user_id}/resend-invite", summary="Reenviar convite (admin only)")
def resend_invite(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "Usuário não encontrado.")
    if not user.invite_token:
        raise HTTPException(400, "Este usuário já aceitou o convite.")

    # Renova o token e a validade
    token   = secrets.token_urlsafe(32)
    expires = datetime.utcnow() + timedelta(hours=INVITE_EXPIRE_HOURS)
    user.invite_token      = token
    user.invite_expires_at = expires
    db.commit()

    invite_url = f"{settings.app_url}/invite/{token}"

    try:
        _send_invite_email(user.email, current_user.username, token)
        return {"ok": True, "message": f"Convite reenviado para {user.email}.", "invite_url": invite_url}
    except Exception as exc:
        import logging
        logging.getLogger(__name__).error("Falha ao reenviar convite: %s", exc)
        return {
            "ok": False,
            "message": f"Token renovado, mas falha ao enviar e-mail: {exc}",
            "invite_url": invite_url,
        }


@router.get("/{user_id}/invite-link", summary="Ver link do convite pendente (admin only)")
def get_invite_link(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "Usuário não encontrado.")
    if not user.invite_token:
        raise HTTPException(400, "Este usuário já aceitou o convite.")

    expires_in_h = None
    if user.invite_expires_at:
        delta = user.invite_expires_at - datetime.utcnow()
        expires_in_h = max(0, int(delta.total_seconds() / 3600))

    return {
        "email":      user.email,
        "invite_url": f"{settings.app_url}/invite/{user.invite_token}",
        "expires_at": user.invite_expires_at.isoformat() if user.invite_expires_at else None,
        "expires_in_hours": expires_in_h,
    }


@router.delete("/{user_id}", summary="Remover membro (admin only)")
def delete_user(
    user_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    if user_id == current_user.id:
        raise HTTPException(400, "Você não pode remover sua própria conta.")

    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "Usuário não encontrado.")

    db.delete(user)
    db.commit()
    return {"ok": True}
