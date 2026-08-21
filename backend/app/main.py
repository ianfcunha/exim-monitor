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
from .reports import weekly_report_loop
from .routers import actions, auth, history, messages, security, servers, status, users
from .routers import settings as settings_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# Versão atual do schema — atualizar junto com cada nova migration
_SCHEMA_VERSION = "014"

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

        # ── Migrations incrementais ────────────────────────────────────────
        if "001" in current and "002" not in current:
            logger.info("Aplicando migration 001 → 002 (alert_history)...")
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS alert_history (
                    id          SERIAL PRIMARY KEY,
                    sent_at     TIMESTAMP NOT NULL DEFAULT NOW(),
                    channel     VARCHAR(20)  NOT NULL,
                    severity    VARCHAR(20)  NOT NULL,
                    problem     VARCHAR(200) NOT NULL,
                    queue_total INTEGER      NOT NULL DEFAULT 0,
                    success     BOOLEAN      NOT NULL DEFAULT TRUE,
                    error_msg   VARCHAR(500)
                )
            """))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_alert_history_ts ON alert_history (sent_at)"
            ))
            conn.execute(text("DELETE FROM alembic_version"))
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
                {"v": "002"},
            )
            logger.info("Migration 002 aplicada com sucesso")
            current = {"002"}

        if "002" in current and "003" not in current:
            logger.info("Aplicando migration 002 → 003 (users, servers, server_id)...")

            # ── Tabela users ──────────────────────────────────────────
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS users (
                    id                SERIAL PRIMARY KEY,
                    email             VARCHAR(255) NOT NULL UNIQUE,
                    username          VARCHAR(100) NOT NULL UNIQUE,
                    password_hash     VARCHAR(500),
                    role              VARCHAR(20)  NOT NULL DEFAULT 'admin',
                    is_active         BOOLEAN      NOT NULL DEFAULT TRUE,
                    email_verified    BOOLEAN      NOT NULL DEFAULT FALSE,
                    invite_token      VARCHAR(200) UNIQUE,
                    invite_expires_at TIMESTAMP,
                    invited_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
                    created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
                    last_login_at     TIMESTAMP
                )
            """))

            # ── Tabela servers ────────────────────────────────────────
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS servers (
                    id                SERIAL PRIMARY KEY,
                    owner_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    name              VARCHAR(100)  NOT NULL,
                    host              VARCHAR(255)  NOT NULL,
                    port              INTEGER       NOT NULL DEFAULT 22,
                    ssh_user          VARCHAR(100)  NOT NULL DEFAULT 'root',
                    ssh_auth_type     VARCHAR(20)   NOT NULL DEFAULT 'password',
                    ssh_secret        VARCHAR(4000) NOT NULL DEFAULT '',
                    script_path       VARCHAR(500)  NOT NULL DEFAULT '/root/diag-exim.sh',
                    is_enabled        BOOLEAN       NOT NULL DEFAULT TRUE,
                    last_connected_at TIMESTAMP,
                    ssh_status        VARCHAR(20)   NOT NULL DEFAULT 'unknown',
                    ssh_error_msg     VARCHAR(500),
                    created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
                    updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
                )
            """))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_servers_owner_id ON servers (owner_id)"
            ))

            # ── Migrar admin do .env para tabela users ────────────────
            from .config import settings as cfg
            from .auth import pwd_context
            pw_hash = pwd_context.hash(cfg.admin_password[:72])
            conn.execute(text("""
                INSERT INTO users (email, username, password_hash, role, is_active, email_verified, created_at)
                VALUES (:email, :username, :pw, 'admin', TRUE, TRUE, NOW())
                ON CONFLICT (username) DO NOTHING
            """), {"email": cfg.admin_email, "username": cfg.admin_username, "pw": pw_hash})

            admin_row = conn.execute(
                text("SELECT id FROM users WHERE username = :u"), {"u": cfg.admin_username}
            ).fetchone()
            admin_id = admin_row[0] if admin_row else None

            # ── Migrar servidor do .env para tabela servers ───────────
            if admin_id:
                from .crypto import encrypt_secret
                ssh_secret = encrypt_secret(cfg.ssh_password or "")
                auth_type  = "password" if cfg.ssh_password else "key"
                if not cfg.ssh_password and cfg.ssh_key_path:
                    try:
                        import os
                        key_content = open(os.path.expanduser(cfg.ssh_key_path)).read()
                        ssh_secret  = encrypt_secret(key_content)
                        auth_type   = "key"
                    except Exception:
                        ssh_secret = ""

                conn.execute(text("""
                    INSERT INTO servers
                        (owner_id, name, host, port, ssh_user, ssh_auth_type,
                         ssh_secret, script_path, is_enabled, created_at, updated_at)
                    VALUES
                        (:owner, :name, :host, :port, :user, :auth_type,
                         :secret, :script, TRUE, NOW(), NOW())
                """), {
                    "owner":     admin_id,
                    "name":      cfg.ssh_host,
                    "host":      cfg.ssh_host,
                    "port":      cfg.ssh_port,
                    "user":      cfg.ssh_user,
                    "auth_type": auth_type,
                    "secret":    ssh_secret,
                    "script":    cfg.script_path,
                })
                logger.info("Servidor %s migrado para a tabela servers", cfg.ssh_host)

            # ── Adicionar server_id aos snapshots ─────────────────────
            conn.execute(text("""
                ALTER TABLE snapshots
                    ADD COLUMN IF NOT EXISTS server_id INTEGER
                    REFERENCES servers(id) ON DELETE CASCADE
            """))

            # Vincular snapshots existentes ao servidor migrado
            if admin_id:
                server_row = conn.execute(
                    text("SELECT id FROM servers WHERE owner_id = :o ORDER BY id LIMIT 1"),
                    {"o": admin_id}
                ).fetchone()
                if server_row:
                    conn.execute(
                        text("UPDATE snapshots SET server_id = :sid WHERE server_id IS NULL"),
                        {"sid": server_row[0]}
                    )

            # ── Adicionar server_id ao alert_settings ─────────────────
            conn.execute(text("""
                ALTER TABLE alert_settings
                    ADD COLUMN IF NOT EXISTS server_id INTEGER
                    REFERENCES servers(id) ON DELETE CASCADE
            """))

            conn.execute(text("DELETE FROM alembic_version"))
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
                {"v": "003"},
            )
            logger.info("Migration 003 aplicada com sucesso")
            current = {"003"}

        if "003" in current and "004" not in current:
            logger.info("Aplicando migration 003 → 004 (users.token_version)...")
            conn.execute(text("""
                ALTER TABLE users
                    ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0
            """))
            conn.execute(text("DELETE FROM alembic_version"))
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
                {"v": "004"},
            )
            logger.info("Migration 004 aplicada com sucesso")
            current = {"004"}

        if "004" in current and "005" not in current:
            logger.info("Aplicando migration 004 → 005 (servers.ssh_host_key_fingerprint)...")
            conn.execute(text("""
                ALTER TABLE servers
                    ADD COLUMN IF NOT EXISTS ssh_host_key_fingerprint VARCHAR(200)
            """))
            conn.execute(text("DELETE FROM alembic_version"))
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
                {"v": "005"},
            )
            logger.info("Migration 005 aplicada com sucesso")
            current = {"005"}

        if "005" in current and "006" not in current:
            logger.info("Aplicando migration 005 → 006 (action_history)...")
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS action_history (
                    id          SERIAL PRIMARY KEY,
                    executed_at TIMESTAMP NOT NULL DEFAULT NOW(),
                    server_id   INTEGER REFERENCES servers(id) ON DELETE SET NULL,
                    actor       VARCHAR(100) NOT NULL,
                    action      VARCHAR(50)  NOT NULL,
                    param       VARCHAR(300),
                    success     BOOLEAN NOT NULL DEFAULT TRUE,
                    message     VARCHAR(500)
                )
            """))
            conn.execute(text("""
                CREATE INDEX IF NOT EXISTS ix_action_history_ts
                    ON action_history (executed_at)
            """))
            conn.execute(text("DELETE FROM alembic_version"))
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
                {"v": "006"},
            )
            logger.info("Migration 006 aplicada com sucesso")
            current = {"006"}

        if "006" in current and "007" not in current:
            logger.info("Aplicando migration 006 → 007 (relatório semanal)...")
            conn.execute(text("""
                ALTER TABLE alert_settings
                    ADD COLUMN IF NOT EXISTS weekly_report_enabled BOOLEAN NOT NULL DEFAULT FALSE
            """))
            conn.execute(text("""
                ALTER TABLE alert_settings
                    ADD COLUMN IF NOT EXISTS weekly_report_last_sent_at TIMESTAMP
            """))
            conn.execute(text("""
                ALTER TABLE alert_history
                    ADD COLUMN IF NOT EXISTS server_id INTEGER
                    REFERENCES servers(id) ON DELETE SET NULL
            """))
            conn.execute(text("DELETE FROM alembic_version"))
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
                {"v": "007"},
            )
            logger.info("Migration 007 aplicada com sucesso")
            current = {"007"}

        if "007" in current and "008" not in current:
            logger.info("Aplicando migration 007 → 008 (webhook genérico)...")
            conn.execute(text("""
                ALTER TABLE alert_settings
                    ADD COLUMN IF NOT EXISTS webhook_url VARCHAR(500) NOT NULL DEFAULT ''
            """))
            conn.execute(text("""
                ALTER TABLE alert_settings
                    ADD COLUMN IF NOT EXISTS webhook_secret VARCHAR(500) NOT NULL DEFAULT ''
            """))
            conn.execute(text("DELETE FROM alembic_version"))
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
                {"v": "008"},
            )
            logger.info("Migration 008 aplicada com sucesso")
            current = {"008"}

        if "008" in current and "009" not in current:
            logger.info("Aplicando migration 008 → 009 (action_history.message → TEXT)...")
            conn.execute(text("""
                ALTER TABLE action_history
                    ALTER COLUMN message TYPE TEXT
            """))
            conn.execute(text("DELETE FROM alembic_version"))
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
                {"v": "009"},
            )
            logger.info("Migration 009 aplicada com sucesso")
            # Mesmo gap de migration chain já corrigido antes (004→005,
            # depois 005→006) e que voltou a acontecer aqui: sem isto, um
            # banco parado exatamente em "008" pularia a 009→010 abaixo
            # silenciosamente, porque "current" nunca refletia a versão
            # recém-aplicada.
            current = {"009"}

        if "009" in current and "010" not in current:
            logger.info("Aplicando migration 009 → 010 (action_plans — plan()/apply(), T3)...")
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS action_plans (
                    id          VARCHAR(36)  PRIMARY KEY,
                    server_id   INTEGER REFERENCES servers(id) ON DELETE SET NULL,
                    actor       VARCHAR(100) NOT NULL,
                    action      VARCHAR(50)  NOT NULL,
                    param       VARCHAR(300),
                    preview     JSONB,
                    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
                    consumed_at TIMESTAMP
                )
            """))
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_action_plans_created_at ON action_plans (created_at)"
            ))
            conn.execute(text("DELETE FROM alembic_version"))
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
                {"v": "010"},
            )
            logger.info("Migration 010 aplicada com sucesso")
            # Mesmo gap de migration chain corrigido de novo em 008→009
            # (e antes em 004→005, 005→006) — sem isto, um banco parado
            # em "009" pularia a 010→011 abaixo silenciosamente.
            current = {"010"}

        if "010" in current and "011" not in current:
            logger.info("Aplicando migration 010 → 011 (servers.capabilities — sondagem de capacidade, T4)...")
            conn.execute(text("""
                ALTER TABLE servers
                    ADD COLUMN IF NOT EXISTS capabilities JSONB
            """))
            conn.execute(text("DELETE FROM alembic_version"))
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
                {"v": "011"},
            )
            logger.info("Migration 011 aplicada com sucesso")
            # Mesmo gap corrigido de novo (008→009, 009→010) — sem isto
            # a 011→012 abaixo seria pulada num banco parado em "010".
            current = {"011"}

        if "011" in current and "012" not in current:
            logger.info("Aplicando migration 011 → 012 (action_history.plan_id/revert_hint, T8)...")
            conn.execute(text("""
                ALTER TABLE action_history
                    ADD COLUMN IF NOT EXISTS plan_id VARCHAR(36)
            """))
            conn.execute(text("""
                ALTER TABLE action_history
                    ADD COLUMN IF NOT EXISTS revert_hint VARCHAR(300)
            """))
            conn.execute(text("DELETE FROM alembic_version"))
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
                {"v": "012"},
            )
            logger.info("Migration 012 aplicada com sucesso")
            # Mesmo gap corrigido de novo (008→009, 009→010, 010→011) —
            # sem isto a 012→013 abaixo seria pulada num banco parado em "011".
            current = {"012"}

        if "012" in current and "013" not in current:
            logger.info("Aplicando migration 012 → 013 (incidents/incident_events, Sessão 2 T1)...")
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS incidents (
                    id                 SERIAL PRIMARY KEY,
                    server_id          INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
                    type               VARCHAR(30)  NOT NULL,
                    severity           VARCHAR(20)  NOT NULL,
                    status             VARCHAR(20)  NOT NULL DEFAULT 'aberto',
                    fingerprint        VARCHAR(300) NOT NULL,
                    entity             VARCHAR(300) NOT NULL,
                    first_seen         TIMESTAMP NOT NULL DEFAULT NOW(),
                    last_seen          TIMESTAMP NOT NULL DEFAULT NOW(),
                    resolved_at        TIMESTAMP,
                    resolution         VARCHAR(20),
                    evidence           JSONB,
                    metrics            JSONB,
                    suggested_fix      JSONB,
                    triggered_by       JSONB,
                    silenced_until     TIMESTAMP,
                    consecutive_clean  INTEGER NOT NULL DEFAULT 0,
                    created_at         TIMESTAMP NOT NULL DEFAULT NOW()
                )
            """))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_incidents_fingerprint ON incidents (fingerprint)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_incidents_status ON incidents (status)"))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_incidents_server_status ON incidents (server_id, status)"))
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS incident_events (
                    id          SERIAL PRIMARY KEY,
                    incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
                    event_type  VARCHAR(20)  NOT NULL,
                    at          TIMESTAMP NOT NULL DEFAULT NOW(),
                    actor       VARCHAR(100) NOT NULL DEFAULT 'system',
                    detail      JSONB
                )
            """))
            conn.execute(text("CREATE INDEX IF NOT EXISTS ix_incident_events_incident ON incident_events (incident_id)"))
            conn.execute(text("""
                ALTER TABLE action_history
                    ADD COLUMN IF NOT EXISTS incident_id INTEGER REFERENCES incidents(id) ON DELETE SET NULL
            """))
            conn.execute(text("DELETE FROM alembic_version"))
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
                {"v": "013"},
            )
            logger.info("Migration 013 aplicada com sucesso")
            current = {"013"}

        if "013" in current and "014" not in current:
            logger.info("Aplicando migration 013 → 014 (detector_config — thresholds por tipo, Sessão 2 T2)...")
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS detector_config (
                    id          SERIAL PRIMARY KEY,
                    server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
                    type        VARCHAR(30) NOT NULL,
                    thresholds  JSONB NOT NULL DEFAULT '{}'::jsonb,
                    updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
                )
            """))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS ix_detector_config_server_type ON detector_config (server_id, type)"
            ))
            conn.execute(text("DELETE FROM alembic_version"))
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
                {"v": "014"},
            )
            logger.info("Migration 014 aplicada com sucesso")

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
    weekly_report_task = asyncio.create_task(weekly_report_loop())
    logger.info(
        "Coletor em background iniciado - quick=%ds, full=%ds",
        settings.quick_interval,
        settings.full_interval,
    )

    yield

    collector_task.cancel()
    retention_task.cancel()
    weekly_report_task.cancel()
    for task in (collector_task, retention_task, weekly_report_task):
        try:
            await task
        except asyncio.CancelledError:
            pass
    logger.info("Tasks de background encerradas")


_FACTORY_DEFAULT_SECRETS = {
    "jwt_secret":         "TROQUE-ME-EM-PRODUCAO",
    "admin_password":     "admin",
    "ssh_encryption_key": "TROQUE-ME-EM-PRODUCAO-FERNET-KEY-32BYTES=",
}


def _guard_production_secrets() -> None:
    """
    Recusa subir em producao com segredos padrao de fabrica intactos.
    install.sh ja gera valores fortes automaticamente; esta checagem existe
    para o caso de alguem subir a stack manualmente (ex.: um .env de
    homologacao que acaba virando producao por engano).
    """
    if settings.environment == "development":
        return
    offending = [
        field for field, default in _FACTORY_DEFAULT_SECRETS.items()
        if getattr(settings, field) == default
    ]
    if offending:
        raise RuntimeError(
            f"ENVIRONMENT={settings.environment!r}, mas os seguintes segredos "
            f"ainda estao com o valor padrao de fabrica: {', '.join(offending)}. "
            "Defina valores fortes em backend/.env antes de subir em producao "
            "(o install.sh faz isso automaticamente), ou defina "
            "ENVIRONMENT=development se este for realmente um ambiente de "
            "desenvolvimento/homologacao."
        )


_guard_production_secrets()

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
app.include_router(users.router)
app.include_router(servers.router)
app.include_router(status.router)
app.include_router(actions.router)
app.include_router(security.router)
app.include_router(history.router)
app.include_router(messages.router)
app.include_router(settings_router.router)


@app.get("/api/health", tags=["meta"])
def health():
    return {"status": "ok", "version": "1.2.0"}
