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

from .collector import background_collector
from .config import settings
from .database import create_tables
from .routers import actions, auth, history, status
from .routers import settings as settings_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    create_tables()
    logger.info("Banco de dados inicializado")

    collector_task = asyncio.create_task(background_collector())
    logger.info(
        "Coletor em background iniciado - quick=%ds, full=%ds",
        settings.quick_interval,
        settings.full_interval,
    )

    yield

    collector_task.cancel()
    try:
        await collector_task
    except asyncio.CancelledError:
        pass
    logger.info("Coletor encerrado")


app = FastAPI(
    title="EXIM Monitor API",
    version="1.1.0",
    description=(
        "API REST para monitoramento e gerenciamento do servidor de e-mail EXIM. "
        "Baseada no script diag-exim.sh v4.8+."
    ),
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(status.router)
app.include_router(actions.router)
app.include_router(history.router)
app.include_router(settings_router.router)


@app.get("/api/health", tags=["meta"])
def health():
    return {"status": "ok", "version": "1.1.0"}
