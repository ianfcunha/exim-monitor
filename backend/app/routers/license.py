"""
Estado da licença desta instalação.

GET /api/license  → estado completo (admin only)

Só leitura: a licença chega pelo .env (MAILIQ_LICENSE) e é conferida
offline contra a chave pública embutida no backend. Não há endpoint para
gravar licença — trocar a licença é editar o .env e reiniciar o backend,
que é o mesmo caminho de todo segredo da instalação.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..auth import require_admin
from ..database import User, get_db
from ..license import license_status

router = APIRouter(prefix="/api/license", tags=["license"])


@router.get("", summary="Estado da licença (admin only)")
def get_license(
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    return license_status(db).to_dict()
