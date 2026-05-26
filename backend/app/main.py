"""
Ponto de entrada da API EXIM Monitor.

Inicializacao com uWSGI (producao):
  uwsgi --ini uwsgi.ini

Inicializacao para desenvolvimento rapido (sem uWSGI):
  python -m fastapi dev app/main.py
"""
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from .collector import background_collector
from .config import settings
from .database import run_retention
from .limiter import limiter
from .routers import actions, auth, history, messages, status
from .routers import settings as settings_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# Versão atual do schema — atualizar junto com cada nova migration
_SCHEMA_VERSION = "001"

_DDL_ALEMBIC_VERSION = """
    CREATE TABLE IF NOT EXISTS alembic_version (
        version_num VARCHAR(32) NOT NULL,
        CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
    )
"""


def run_migrations() -> None:
    """
    Garante que o banco esteja no schema correto usando o engine da aplicacao
    diretamente, sem criar um engine secundario via Alembic CLI (que pode travar
    dentro do lifespan assíncrono do FastAPI/uvicorn).

    Comportamento:
      - Banco novo (sem tabelas): cria tudo via Base.metadata.create_all + stamp
      - Banco existente sem alembic_version: faz stamp para registrar estado atual
      - Banco ja na versao atual: no-op rapido
      - Banco em versao anterior: aplica DDL incremental definido aqui
    """
    from sqlalchemy import inspect, text

    from .database import Base, engine

    with engine.begin() as conn:
        inspector = inspect(conn)
        tables    = inspector.get_table_names()
        has_alembic   = "alembic_version" in tables
        has_snapshots = "snapshots" in tables

        # ── Banco completamente novo ──────────────────────────────────────
        if not has_snapshots:
            logger.info("Banco novo detectado — criando tabelas...")
            Base.metadata.create_all(conn)
            conn.execute(text(_DDL_ALEMBIC_VERSION))
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v) ON CONFLICT DO NOTHING"),
                {"v": _SCHEMA_VERSION},
            )
            logger.info("Banco de dados pronto (schema %s)", _SCHEMA_VERSION)
            return

        # ── Banco existente sem controle de versao ────────────────────────
        if not has_alembic:
            logger.info("Banco existente sem versao — registrando schema %s", _SCHEMA_VERSION)
            conn.execute(text(_DDL_ALEMBIC_VERSION))
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v) ON CONFLICT DO NOTHING"),
                {"v": _SCHEMA_VERSION},
            )
            return

        # ── Verificar versao atual ────────────────────────────────────────
        rows    = conn.execute(text("SELECT version_num FROM alembic_version")).fetchall()
        current = {r[0] for r in rows}
        logger.info("Schema atual: %s", current)

        if _SCHEMA_VERSION in current:
            logger.info("Banco de dados ja esta atualizado (schema %s)", _SCHEMA_VERSION)
            return

        # ── Migrations incrementais (adicionar aqui ao criar versoes futuras) ──
        # Exemplo para versao 002:
        # if "001" in current and "002" not in current:
        #     conn.execute(text("ALTER TABLE snapshots ADD COLUMN exemplo TEXT"))
        #     conn.execute(text("DELETE FROM alembic_version"))
        #     conn.execute(text("INSERT INTO alembic_version VALUES ('002')"))
        logger.info("Banco de dados pronto (schema %s)", _SCHEMA_VERSION)


async def retention_loop() -> None:
    """
    Job de retencao que roda diariamente.
    Aguarda 60s apos startup para nao competir com a inicializacao.
    """
    await asyncio.sleep(60)
    while True:
        try:
            result = run_retention()
            logger.info(
                "Retencao de snapshots: removidos %d quick (>7d) + %d antigos (>90d)",
                result["deleted_quick_7d"],
                result["deleted_all_90d"],
            )
        except Exception:
            logger.exception("Erro no job de retencao de snapshots")
        await asyncio.sleep(24 * 3600)  # proxima execucao em 24h


@asynccontextmanager
async def lifespan(app: FastAPI):
    run_migrations()
    logger.info("Banco de dados pronto")

    collector_task = asyncio.create_task(background_collector())
    retention_task = asyncio.create_task(retention_loop())
    logger.info(
        "Coletor em background iniciado - quick=%ds, full=%ds",
        settings.quick_interval,
        settings.full_interval,
    )

    yield

    collector_task.cancel()
    retention_task.cancel()
    for task in (collector_task, retention_task):
        try:
            await task
        except asyncio.CancelledError:
            pass
    logger.info("Tasks de background encerradas")


app = FastAPI(
    title="EXIM Monitor API",
    version="1.2.0",
    description=(
        "API REST para monitoramento e gerenciamento do servidor de e-mail EXIM. "
        "Baseada no script diag-exim.sh v4.8+."
    ),
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

# Rate limiting
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
app.add_middleware(SlowAPIMiddleware)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers
app.include_router(auth.router)
app.include_router(status.router)
app.include_router(actions.router)
app.include_router(history.router)
app.include_router(messages.router)
app.include_router(settings_router.router)


@app.get("/api/health", tags=["meta"])
def health():
    return {"status": "ok", "version": "1.2.0"}
