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


def decrypt_secret(token: str) -> str:
    """Decriptografa um segredo armazenado. Retorna string vazia se inválido."""
    if not token:
        return ""
    try:
        return _get_fernet().decrypt(token.encode("utf-8")).decode("utf-8")
    except InvalidToken:
        logger.error("Falha ao decriptografar segredo SSH — token inválido ou chave trocada")
        return ""
