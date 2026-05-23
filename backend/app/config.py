"""
Configurações da aplicação via variáveis de ambiente / arquivo .env
Todas as variáveis podem ser sobrescritas no .env do backend.
"""
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
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
