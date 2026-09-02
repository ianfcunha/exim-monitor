"""
Caminho único para "monte a config SSH deste servidor — e se o segredo não
abrir, diga isso alto".

`build_server_cfg()` levanta `SecretDecryptionError` desde a Sessão 1
(AUDITORIA.md item 1): antes `decrypt_secret()` devolvia `""` em silêncio,
a conexão seguinte falhava com um erro de rede genérico, e o operador não
tinha como saber que o problema real era a `SSH_ENCRYPTION_KEY` — chave
trocada, ou backup do banco restaurado sem o `.env` correspondente.

Falhar alto só resolve se TODO chamador tratar. O bloco de tratamento —
marcar `ssh_status="credential_error"`, gravar o motivo, responder 503 —
estava copiado em quatro routers e **ausente em dois** (`messages.py` e
`status.py`, que ainda montavam o dict de config à mão em vez de chamar
`build_server_cfg`). Nesses dois, o Log Viewer e a coleta forçada
devolviam 500 com um erro cru: exatamente o sintoma que a mudança da
Sessão 1 existia para eliminar, sobrevivendo nos dois lugares que
esqueceram de a adotar.

Com uma função só, esquecer deixa de ser possível: quem precisa de uma
config SSH chama daqui, e o tratamento vem junto.

Por que 503 e não 500: não é um erro inesperado do servidor, é um estado
de configuração conhecido, com uma mensagem que diz o que fazer.
"""
import logging
from typing import Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from .crypto import SecretDecryptionError
from .database import Server, build_server_cfg

logger = logging.getLogger(__name__)

CREDENTIAL_ERROR = "credential_error"


def mark_credential_error(db: Session, server: Server, exc: Exception) -> None:
    """
    Registra no servidor que o segredo dele não abre.

    Status próprio, distinto de "error": para quem lê o painel, "Erro de
    credencial" e "Erro SSH" mandam procurar em lugares completamente
    diferentes — a chave de criptografia do painel, ou a rede/o servidor
    remoto. Persistir na hora (e não esperar o próximo ciclo do coletor)
    faz a tela refletir o problema no mesmo instante em que alguém
    esbarra nele.
    """
    logger.error(
        "Segredo SSH ilegível para server_id=%s (%s): %s",
        getattr(server, "id", "?"), getattr(server, "name", "?"), exc,
    )
    try:
        server.ssh_status = CREDENTIAL_ERROR
        server.ssh_error_msg = str(exc)[:500]
        db.commit()
    except Exception:
        # Não poder anotar o motivo não pode impedir de REPORTAR o motivo.
        logger.exception("Falha ao marcar credential_error no servidor")
        db.rollback()


def server_cfg_or_503(db: Session, server: Optional[Server]) -> dict:
    """
    Config SSH do servidor, ou 503 com o motivo legível.

    404 se o servidor não existe/não é acessível — a checagem fica aqui
    para o chamador não precisar repetir as duas.
    """
    if server is None:
        raise HTTPException(404, "Servidor não encontrado.")
    try:
        return build_server_cfg(server)
    except SecretDecryptionError as exc:
        mark_credential_error(db, server, exc)
        raise HTTPException(503, str(exc)) from exc
