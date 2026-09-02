"""
Suporte — o pacote de diagnóstico.

GET /api/support/diagnostic-package  → baixa o arquivo (admin only)
GET /api/support/diagnostic-preview  → o mesmo conteúdo, para exibir na tela

Duas rotas para o mesmo dado de propósito: quem vai enviar um arquivo
nosso para fora tem o direito de ler antes o que está mandando, e "confie,
não tem nada demais aí" não é uma resposta aceitável. A prévia é o mesmo
JSON, sem o cabeçalho de download.
"""
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from ..auth import require_admin
from ..database import User, get_db, record_action_history
from ..diagnostics import render_diagnostic_json
from ..limiter import limiter

router = APIRouter(prefix="/api/support", tags=["support"])


def _nome_arquivo() -> str:
    from ..config import settings

    # Domínio do painel, quando dá para deduzir — dois pacotes de clientes
    # diferentes na mesma caixa de entrada precisam ser distinguíveis pelo
    # nome do arquivo, sem abrir os dois.
    origem = ""
    for url in (settings.cors_origins or []):
        m = re.search(r"https?://([^/:]+)", url or "")
        if m and m.group(1) not in ("localhost", "127.0.0.1"):
            origem = m.group(1)
            break
    carimbo = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    parte = f"-{origem}" if origem else ""
    return f"mailiq-diagnostico{parte}-{carimbo}.json"


@router.get("/diagnostic-package", summary="Pacote de diagnóstico para o suporte (admin only)")
@limiter.limit("6/hour")
def diagnostic_package(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """
    Gera o pacote e devolve como download.

    Fica registrado no histórico de auditoria: o arquivo sai da máquina do
    cliente, então quem o gerou e quando é informação que o próprio
    cliente pode querer conferir depois.

    Limite de 6/hora — gerar isto varre várias tabelas, e não existe
    motivo legítimo para pedir mais que isso.
    """
    corpo = render_diagnostic_json(db, gerado_por=current_user.username)

    try:
        record_action_history(
            db, server_id=None, actor=current_user.username,
            action="support:diagnostic-package", param=None, success=True,
            message="Pacote de diagnóstico gerado para envio ao suporte.",
        )
    except Exception:
        # Não poder auditar não pode impedir de gerar o diagnóstico —
        # ele costuma ser pedido justamente quando algo já está quebrado.
        pass

    return Response(
        content=corpo,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{_nome_arquivo()}"'},
    )


@router.get("/diagnostic-preview", summary="Prévia do pacote, para conferir antes de enviar")
@limiter.limit("12/hour")
def diagnostic_preview(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    return Response(
        content=render_diagnostic_json(db, gerado_por=current_user.username),
        media_type="application/json",
    )
