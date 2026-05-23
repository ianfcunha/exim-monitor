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
from pathlib import Path

from alembic import command as alembic_command
from alembic.config import Config as AlembicConfig
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from .collector import background_collector
from .config import settings
from .database import run_retention
from .limiter import limiter
from .routers import actions, auth, history, status
from .routers import settings as settings_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# Caminho absoluto para alembic.ini — robusto independente do CWD
_ALEMBIC_INI = Path(__file__).resolve().parent.parent / "alembic.ini"


def run_migrations() -> None:
    """
    Aplica migrations pendentes via Alembic.

    Comportamento:
      - Banco novo (sem alembic_version): executa todas as migrations
      - Banco existente sem alembic_version mas com tabelas (vindo do create_all):
        faz stamp head para registrar o estado atual sem re-criar nada
      - Banco com alembic_version: aplica apenas o que esta pendente
    """
    from sqlalchemy import inspect

    from .database import engine

    alembic_cfg = AlembicConfig(str(_ALEMBIC_INI))

    with engine.connect() as conn:
        inspector = inspect(conn)
        tables = inspector.get_table_names()
        has_alembic   = "alembic_version" in tables
        has_snapshots = "snapshots" in tables

        if not has_alembic and has_snapshots:
            # Banco existente sem controle de versao — registra estado atual
            logger.info("Banco existente detectado — registrando versao atual (stamp head)")
            alembic_command.stamp(alembic_cfg, "head")
            return

    logger.info("Executando migrations Alembic...")
    alembic_command.upgrade(alembic_cfg, "head")
    logger.info("Migrations concluidas")


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
app.include_router(settings_router.router)


@app.get("/api/health", tags=["meta"])
def health():
    return {"status": "ok", "version": "1.2.0"}
