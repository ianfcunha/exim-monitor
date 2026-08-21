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
from typing import Optional, Tuple

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519

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


def generate_ed25519_keypair(comment: str) -> Tuple[str, str]:
    """
    Gera um par de chaves Ed25519 novo — usado por
    POST /api/servers/{id}/generate-key (Tarefa 7, Sessão 1,
    pós-auditoria): o painel gera a chave, mostra a pública pro admin
    colar no mailiq-bootstrap.sh, e guarda a privada (cifrada) como se
    fosse um ssh_secret comum.

    paramiko não sabe GERAR chave Ed25519 (só carregar) — por isso usa
    a lib `cryptography` diretamente aqui, e exporta em formato OpenSSH
    (o mesmo `_get_client()` em ssh.py já sabe carregar via
    paramiko.Ed25519Key.from_private_key(), sem mudança nenhuma lá).

    Retorna (private_key_openssh_pem, public_key_line).
    """
    private_key = ed25519.Ed25519PrivateKey.generate()
    public_key = private_key.public_key()

    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.OpenSSH,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("utf-8")

    public_line = public_key.public_bytes(
        encoding=serialization.Encoding.OpenSSH,
        format=serialization.PublicFormat.OpenSSH,
    ).decode("utf-8")
    if comment:
        public_line = f"{public_line} {comment}"

    return private_pem, public_line


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
