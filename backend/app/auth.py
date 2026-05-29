"""
Autenticação JWT multi-usuário.

Token carrega: sub (username), user_id, role, owner_id.
  - Admin:  owner_id == user_id  (vê os próprios servidores)
  - Viewer: owner_id == id do admin que o convidou

get_current_user  → retorna User ORM (requer DB)
require_admin     → dependency que rejeita viewers
"""
from datetime import datetime, timedelta
from typing import Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from .config import settings
from .database import SessionLocal, User, get_db, get_user_by_username

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def _truncate(password: str) -> str:
    """bcrypt suporta no máximo 72 bytes."""
    return password.encode("utf-8")[:72].decode("utf-8", errors="ignore")


def hash_password(plain: str) -> str:
    return pwd_context.hash(_truncate(plain))


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(_truncate(plain), hashed)


def create_access_token(user: User, expires_delta: Optional[timedelta] = None) -> str:
    owner_id = user.id if user.role == "admin" else (user.invited_by or user.id)
    to_encode = {
        "sub":      user.username,
        "user_id":  user.id,
        "role":     user.role,
        "owner_id": owner_id,
    }
    expire = datetime.utcnow() + (
        expires_delta or timedelta(minutes=settings.jwt_expire_minutes)
    )
    to_encode["exp"] = expire
    return jwt.encode(to_encode, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def authenticate_user(db: Session, username: str, password: str) -> Optional[User]:
    """
    Retorna o User se autenticado, None caso contrário.
    Tenta primeiro no banco; se não existir, aceita o admin do .env como fallback
    (compatibilidade com instalações sem migration).
    """
    user = get_user_by_username(db, username)

    if user:
        if not user.is_active or not user.email_verified:
            return None
        if not user.password_hash:
            return None
        if not verify_password(password, user.password_hash):
            return None
        return user

    # ── Fallback: admin do .env (antes da migration) ──────────────────
    if username == settings.admin_username and password == settings.admin_password:
        # Cria um User sintético (não persistido) para compatibilidade
        synthetic = User(
            id=0,
            email=settings.admin_email,
            username=settings.admin_username,
            role="admin",
            is_active=True,
            email_verified=True,
            invited_by=None,
        )
        return synthetic

    return None


def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    """Dependency — valida JWT e retorna o User ORM."""
    exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Token inválido ou expirado",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(
            token, settings.jwt_secret, algorithms=[settings.jwt_algorithm]
        )
        username: Optional[str] = payload.get("sub")
        if not username:
            raise exc
    except JWTError:
        raise exc

    user = get_user_by_username(db, username)
    if user:
        if not user.is_active:
            raise exc
        return user

    # Fallback sintético para admin do .env
    if username == settings.admin_username:
        return User(
            id=0,
            email=settings.admin_email,
            username=settings.admin_username,
            role="admin",
            is_active=True,
            email_verified=True,
            invited_by=None,
        )

    raise exc


def require_admin(current_user: User = Depends(get_current_user)) -> User:
    """Dependency — rejeita viewers com 403."""
    if current_user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Apenas administradores podem executar esta ação.",
        )
    return current_user
