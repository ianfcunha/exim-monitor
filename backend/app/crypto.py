"""
Helper de criptografia simétrica (Fernet) para segredos SSH.

Os segredos (senha ou conteúdo da chave privada) são criptografados antes
de persistir no banco e decriptografados ao montar a conexão SSH.

Uso:
    from .crypto import encrypt_secret, decrypt_secret

    stored = encrypt_secret("minha-senha-ssh")
    original = decrypt_secret(stored)
"""
import logging
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

from .config import settings

logger = logging.getLogger(__name__)

_fernet: Optional[Fernet] = None


def _get_fernet() -> Fernet:
    global _fernet
    if _fernet is None:
        key = settings.ssh_encryption_key.encode()
        try:
            _fernet = Fernet(key)
        except Exception as exc:
            raise RuntimeError(
                "SSH_ENCRYPTION_KEY inválida. Gere uma nova com: "
                "python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
            ) from exc
    return _fernet


def encrypt_secret(plaintext: str) -> str:
    """Criptografa um segredo e retorna string base64 segura para armazenar no banco."""
    if not plaintext:
        return ""
    return _get_fernet().encrypt(plaintext.encode("utf-8")).decode("utf-8")


class SecretDecryptionError(Exception):
    """
    Segredo SSH não pôde ser decriptografado — a SSH_ENCRYPTION_KEY atual
    não bate com a que cifrou este segredo (chave trocada, backup do
    banco restaurado sem o .env correspondente, ou dado corrompido).

    T6 (Sessão 1, pós-auditoria): antes decrypt_secret() engolia esse
    erro e devolvia "" — a conexão SSH subsequente falhava com uma
    senha/chave vazia, e o operador via um erro de rede genérico sem
    nenhuma pista de que o problema real era a chave de criptografia.
    Falhar alto aqui deixa quem chama distinguir esse caso e marcar o
    servidor com um status próprio ("credencial ilegível"), não "erro".
    """


def decrypt_secret(token: str) -> str:
    """Decriptografa um segredo armazenado. Levanta SecretDecryptionError
    se o token existir mas não puder ser decriptografado — nunca retorna
    um segredo vazio/silencioso para um token que deveria ser válido."""
    if not token:
        return ""
    try:
        return _get_fernet().decrypt(token.encode("utf-8")).decode("utf-8")
    except InvalidToken as exc:
        logger.error("Falha ao decriptografar segredo SSH — token inválido ou chave trocada")
        raise SecretDecryptionError(
            "Não foi possível decriptografar o segredo SSH — a SSH_ENCRYPTION_KEY "
            "atual não bate com a que cifrou este segredo. Se você restaurou um "
            "backup do banco, confirme que o backend/.env correspondente também "
            "foi restaurado junto."
        ) from exc
