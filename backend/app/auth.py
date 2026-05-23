"""
Autenticação JWT para a API.
Token obtido via POST /api/auth/login com usuário/senha do .env.
"""
from datetime import datetime, timedelta
from typing import Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext

from .config import settings

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def _truncate(password: str) -> str:
    """bcrypt suporta no máximo 72 bytes — trunca para evitar erro."""
    return password.encode("utf-8")[:72].decode("utf-8", errors="ignore")


# Hash da senha admin gerado uma única vez na importação do módulo
_ADMIN_HASH: str = pwd_context.hash(_truncate(settings.admin_password))


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(_truncate(plain), hashed)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    to_encode = data.copy()
    expire = datetime.utcnow() + (
        expires_delta or timedelta(minutes=settings.jwt_expire_minutes)
    )
    to_encode["exp"] = expire
    return jwt.encode(to_encode, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def authenticate_user(username: str, password: str) -> bool:
    """Retorna True se as credenciais batem com as do .env."""
    return username == settings.admin_username and verify_password(password, _ADMIN_HASH)


def get_current_user(token: str = Depends(oauth2_scheme)) -> str:
    """Dependency do FastAPI — valida o JWT e retorna o username."""
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
        return username
    except JWTError:
        raise exc
