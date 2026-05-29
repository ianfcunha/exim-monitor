"""
Alembic env.py — EXIM Monitor

A URL do banco é lida das settings da aplicação (via .env / variáveis de ambiente),
garantindo que não haja credenciais hardcoded em nenhum arquivo versionado.
"""
import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool

# Garante que /app esteja no path para importar os módulos da aplicação
# (necessário tanto ao rodar `alembic` via CLI quanto via código no container)
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.config import settings          # pydantic-settings — lê .env
from app.database import Base            # DeclarativeBase com todos os modelos

# Objeto de configuração do Alembic (lê alembic.ini)
config = context.config

# Injeta a URL do banco dinamicamente — nunca fica no alembic.ini
config.set_main_option("sqlalchemy.url", settings.database_url)

# Configura logging conforme definido no alembic.ini
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Metadados dos modelos — permite autogenerate de migrations
target_metadata = Base.metadata


def run_migrations_offline() -> None:
    """
    Modo offline: gera SQL sem conectar ao banco.
    Usado com `alembic upgrade --sql`.
    """
    url = config.get_main_option("sqlalchemy.url")
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """
    Modo online: conecta ao banco e aplica migrations.
    Usado na inicialização do container via `run_migrations()` em main.py.
    """
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
        )
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
