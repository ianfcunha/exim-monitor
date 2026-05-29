"""
Endpoint de autenticação.
POST /api/auth/login  →  retorna JWT Bearer token
"""
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.security import OAuth2PasswordRequestForm

from ..auth import authenticate_user, create_access_token
from ..limiter import limiter

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login", summary="Obtém token JWT")
@limiter.limit("5/minute")          # máximo 5 tentativas por minuto por IP
def login(request: Request, response: Response, form: OAuth2PasswordRequestForm = Depends()):
    if not authenticate_user(form.username, form.password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Usuário ou senha inválidos",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = create_access_token({"sub": form.username})
    return {"access_token": token, "token_type": "bearer"}
