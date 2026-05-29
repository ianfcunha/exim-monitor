"""
Endpoint de autenticação.
POST /api/auth/login  →  retorna JWT Bearer token
GET  /api/auth/me     →  retorna dados do usuário autenticado
"""
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session

from ..auth import authenticate_user, create_access_token, get_current_user
from ..database import User, get_db
from ..limiter import limiter

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login", summary="Obtém token JWT")
@limiter.limit("5/minute")
def login(
    request: Request,
    response: Response,
    form: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db),
):
    user = authenticate_user(db, form.username, form.password)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Usuário ou senha inválidos",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = create_access_token(user)
    return {
        "access_token": token,
        "token_type": "bearer",
        "role": user.role,
        "username": user.username,
    }


@router.get("/me", summary="Dados do usuário autenticado")
def me(current_user: User = Depends(get_current_user)):
    return {
        "id":             current_user.id,
        "username":       current_user.username,
        "email":          current_user.email,
        "role":           current_user.role,
        "email_verified": current_user.email_verified,
    }
