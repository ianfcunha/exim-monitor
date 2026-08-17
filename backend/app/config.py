"""
Configurações da aplicação via variáveis de ambiente / arquivo .env
Todas as variáveis podem ser sobrescritas no .env do backend.
"""
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # ── Ambiente ────────────────────────────────────────────────────
    # "development" (default) ou "production". Em producao, o startup
    # recusa subir se segredos de fabrica (jwt_secret, admin_password,
    # ssh_encryption_key) nao tiverem sido trocados — ver main.py.
    environment: str = "development"

    # ── SSH ─────────────────────────────────────────────────────────
    # Host do servidor EXIM (IP ou FQDN)
    ssh_host: str = "localhost"
    ssh_port: int = 22
    ssh_user: str = "root"
    # Caminho da chave privada (deixe em branco para usar senha)
    ssh_key_path: str = "~/.ssh/id_rsa"
    # Senha SSH (não recomendado; prefira chave)
    ssh_password: str = ""

    # Caminho absoluto do script no servidor remoto
    script_path: str = "/root/diag-exim.sh"

    # ── Autenticação ─────────────────────────────────────────────────
    jwt_secret: str = "TROQUE-ME-EM-PRODUCAO"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 480  # 8 horas

    admin_username: str = "admin"
    admin_password: str = "admin"  # TROQUE no .env
    admin_email: str = "admin@localhost"  # e-mail do admin inicial

    # ── Criptografia de segredos SSH ─────────────────────────────────
    # Gere com: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
    ssh_encryption_key: str = "TROQUE-ME-EM-PRODUCAO-FERNET-KEY-32BYTES="

    # ── Resend (convites e verificação de e-mail) ────────────────────
    resend_api_key: str = ""
    resend_from: str = "Mail IQ <noreply@seudominio.com>"

    # ── URL pública do frontend (usada nos links de convite) ─────────
    app_url: str = "http://localhost:5173"

    # ── Banco de dados PostgreSQL ────────────────────────────────────
    # Formato: postgresql://usuario:senha@host:porta/banco
    database_url: str = "postgresql://exim:exim@localhost:5432/exim_monitor"

    # ── CORS ─────────────────────────────────────────────────────────
    # Em produção restrinja para o domínio real do frontend
    cors_origins: list[str] = ["http://localhost:5173", "http://localhost:4173"]

    # ── Intervalos de coleta (segundos) ──────────────────────────────
    quick_interval: int = 30     # heartbeat leve
    full_interval: int = 300     # relatório completo (5 min)

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()
