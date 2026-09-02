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
from .ssh import close_all_pooled
from .config import settings
from .database import run_retention
from .limiter import limiter
from .monthly_report import monthly_report_loop
from .reports import weekly_report_loop
from .routers import actions, auth, history, incidents, messages, reputation, security, servers, status, users
from .routers import settings as settings_router
from .version import APP_VERSION, version_info

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# Versão atual do schema — atualizar junto com cada nova migration
_SCHEMA_VERSION = "024"

_DDL_ALEMBIC_VERSION = """
    CREATE TABLE IF NOT EXISTS alembic_version (
        version_num VARCHAR(32) NOT NULL,
        CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
    )
"""


def _seed_admin_user(conn) -> None:
    """
    Garante que o admin definido em .env (ADMIN_USERNAME/ADMIN_PASSWORD)
    exista como linha na tabela users. Idempotente (ON CONFLICT DO NOTHING).

    Necessário tanto no bootstrap de banco novo quanto no caminho de
    migração legado — sem a linha real, auth.py devolve um User sintético
    com id=0 e toda FK pra users.id (ex.: servers.owner_id) quebra.
    """
    from sqlalchemy import text

    from .auth import pwd_context
    from .config import settings as cfg

    pw_hash = pwd_context.hash(cfg.admin_password[:72])
    conn.execute(text("""
        INSERT INTO users (email, username, password_hash, role, is_active, email_verified, token_version, created_at)
        VALUES (:email, :username, :pw, 'admin', TRUE, TRUE, 0, NOW())
        ON CONFLICT (username) DO NOTHING
    """), {"email": cfg.admin_email, "username": cfg.admin_username, "pw": pw_hash})


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
            # Sem esta linha o login cai no User sintético id=0 (auth.py) e
            # criar servidor (servers.owner_id -> users.id) estoura 500.
            _seed_admin_user(conn)
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
            _seed_admin_user(conn)
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
            _seed_admin_user(conn)

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
            current = {"014"}

        if "014" in current and "015" not in current:
            logger.info("Aplicando migration 014 → 015 (baseline_metrics — histórico horário 30d, Sessão 2 T3)...")
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS baseline_metrics (
                    id          SERIAL PRIMARY KEY,
                    server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
                    entity      VARCHAR(300) NOT NULL DEFAULT '',
                    metric      VARCHAR(50)  NOT NULL,
                    hour_of_day INTEGER      NOT NULL,
                    samples     JSONB NOT NULL DEFAULT '[]'::jsonb,
                    mean        DOUBLE PRECISION,
                    stddev      DOUBLE PRECISION,
                    updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
                )
            """))
            conn.execute(text(
                "CREATE UNIQUE INDEX IF NOT EXISTS ix_baseline_metrics_lookup "
                "ON baseline_metrics (server_id, entity, metric, hour_of_day)"
            ))
            conn.execute(text("DELETE FROM alembic_version"))
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
                {"v": "015"},
            )
            logger.info("Migration 015 aplicada com sucesso")
            current = {"015"}

        if "015" in current and "016" not in current:
            logger.info("Aplicando migration 015 → 016 (notificação de incidentes — anti-ruído, Sessão 2 T4)...")
            conn.execute(text("""
                ALTER TABLE alert_settings
                    ADD COLUMN IF NOT EXISTS incident_notify_critical BOOLEAN NOT NULL DEFAULT TRUE
            """))
            conn.execute(text("""
                ALTER TABLE alert_settings
                    ADD COLUMN IF NOT EXISTS incident_notify_atencao BOOLEAN NOT NULL DEFAULT TRUE
            """))
            conn.execute(text("""
                ALTER TABLE alert_settings
                    ADD COLUMN IF NOT EXISTS muted_incident_types JSONB NOT NULL DEFAULT '[]'::jsonb
            """))
            conn.execute(text("""
                ALTER TABLE alert_settings
                    ADD COLUMN IF NOT EXISTS night_silence_start VARCHAR(5) NOT NULL DEFAULT ''
            """))
            conn.execute(text("""
                ALTER TABLE alert_settings
                    ADD COLUMN IF NOT EXISTS night_silence_end VARCHAR(5) NOT NULL DEFAULT ''
            """))
            conn.execute(text("DELETE FROM alembic_version"))
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
                {"v": "016"},
            )
            logger.info("Migration 016 aplicada com sucesso")
            # Recorrente nesta base: bloco de migration sem atualizar `current`
            # no fim quebra silenciosamente qualquer cadeia de N→N+1 que
            # aterrisse além dele num boot só — já foi corrigido 5x antes
            # (ver histórico de migrations 004→005 em diante); faltava aqui.
            current = {"016"}

        if "016" in current and "017" not in current:
            logger.info("Aplicando migration 016 → 017 (impacto por incidente + custo estimado, Sessão 3 T1)...")
            conn.execute(text("""
                ALTER TABLE incidents
                    ADD COLUMN IF NOT EXISTS impact JSONB
            """))
            conn.execute(text("""
                ALTER TABLE alert_settings
                    ADD COLUMN IF NOT EXISTS cost_per_sysadmin_hour_brl DOUBLE PRECISION
            """))
            conn.execute(text("""
                ALTER TABLE alert_settings
                    ADD COLUMN IF NOT EXISTS cost_per_ticket_brl DOUBLE PRECISION
            """))
            conn.execute(text("DELETE FROM alembic_version"))
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
                {"v": "017"},
            )
            logger.info("Migration 017 aplicada com sucesso")
            current = {"017"}

        if "017" in current and "018" not in current:
            logger.info("Aplicando migration 017 → 018 (relatório mensal por servidor/frota, Sessão 3 T3)...")
            conn.execute(text("""
                ALTER TABLE alert_settings
                    ADD COLUMN IF NOT EXISTS monthly_report_enabled BOOLEAN NOT NULL DEFAULT FALSE
            """))
            conn.execute(text("""
                ALTER TABLE alert_settings
                    ADD COLUMN IF NOT EXISTS monthly_report_last_sent_at TIMESTAMP
            """))
            conn.execute(text("DELETE FROM alembic_version"))
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
                {"v": "018"},
            )
            logger.info("Migration 018 aplicada com sucesso")
            current = {"018"}

        if "018" in current and "019" not in current:
            logger.info("Aplicando migration 018 → 019 (org_id — preparação de schema, Sessão 3 T5)...")
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS organizations (
                    id         SERIAL PRIMARY KEY,
                    name       VARCHAR(200) NOT NULL,
                    created_at TIMESTAMP NOT NULL DEFAULT NOW()
                )
            """))
            conn.execute(text("""
                ALTER TABLE users
                    ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL
            """))
            conn.execute(text("""
                ALTER TABLE servers
                    ADD COLUMN IF NOT EXISTS org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL
            """))
            conn.execute(text("DELETE FROM alembic_version"))
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
                {"v": "019"},
            )
            logger.info("Migration 019 aplicada com sucesso")
            current = {"019"}

        if "019" in current and "020" not in current:
            logger.info("Aplicando migration 019 → 020 (check_results + subtipo no incidente, Sessão 4 T1/T3/T4)...")
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS check_results (
                    id          SERIAL PRIMARY KEY,
                    server_id   INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
                    check_key   VARCHAR(100) NOT NULL,
                    label       VARCHAR(120) NOT NULL,
                    status      VARCHAR(20)  NOT NULL,
                    reason      TEXT NOT NULL DEFAULT '',
                    detail      JSONB,
                    observed_at TIMESTAMP NOT NULL DEFAULT NOW()
                )
            """))
            conn.execute(text("""
                CREATE INDEX IF NOT EXISTS ix_check_results_lookup
                    ON check_results (server_id, check_key, observed_at)
            """))
            conn.execute(text("""
                ALTER TABLE incidents ADD COLUMN IF NOT EXISTS subtype VARCHAR(30) NOT NULL DEFAULT ''
            """))
            # T4: fingerprints antigos eram "tipo:servidor:entidade", sem
            # subtipo e com a entidade no rótulo textual em que o detector
            # a produziu (um IPv4 aparecia ora como "ip:", ora como
            # "domain:"). Reescrever os que ainda estão abertos evita que
            # o próximo ciclo os trate como incidentes novos e abra
            # duplicatas ao lado dos originais.
            rows = conn.execute(text("""
                SELECT id, type, entity, server_id, triggered_by
                  FROM incidents
                 WHERE status IN ('aberto', 'em_observacao', 'mitigado')
            """)).fetchall()
            from .detectors import make_fingerprint
            _SUBTYPE_BY_RULE = {
                "reputation.blocklist": "blocklist",
                "reputation.dns_auth_missing": "dns_auth",
                "reputation.cert_expiring": "cert",
                "reputation.cert_expired": "cert",
                "queue_stuck.consecutive_growth": "fila",
                "queue_stuck.frozen_growth": "frozen",
                "dest_deferral.share_of_total": "destino",
            }
            for row in rows:
                rule = (row[4] or {}).get("rule", "")
                subtype = _SUBTYPE_BY_RULE.get(rule, "conta" if row[1] == "auth_abuse" else "")
                conn.execute(
                    text("UPDATE incidents SET subtype = :s, fingerprint = :f WHERE id = :i"),
                    {"s": subtype, "f": make_fingerprint(row[1], subtype, row[3], row[2]), "i": row[0]},
                )
            conn.execute(text("DELETE FROM alembic_version"))
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
                {"v": "020"},
            )
            logger.info("Migration 020 aplicada com sucesso (%d incidentes abertos re-impressos)", len(rows))
            current = {"020"}

        if "020" in current and "021" not in current:
            logger.info("Aplicando migration 020 → 021 (incidente não reverificável + invalidação dos abertos por bug, Sessão 4 T1)...")
            conn.execute(text("""
                ALTER TABLE incidents ADD COLUMN IF NOT EXISTS unverified_since TIMESTAMP
            """))
            # Incidentes abertos cuja métrica de abertura é implausível só
            # podem ter vindo do defeito que esta sessão corrigiu — o
            # INC-58 foi aberto com observed = -20687 dias (~56 anos de
            # certificado vencido). Não é um incidente que se resolveu:
            # é um que nunca deveria ter existido. Fecha com resolução
            # própria ("invalidada") em vez de sumir com a linha, para o
            # histórico continuar contando o que aconteceu.
            invalidated = conn.execute(text("""
                UPDATE incidents
                   SET status = 'resolvido',
                       resolved_at = NOW(),
                       resolution = 'invalidada'
                 WHERE status IN ('aberto', 'em_observacao', 'mitigado')
                   AND (triggered_by->>'observed') ~ '^-?[0-9]+$'
                   AND ((triggered_by->>'observed')::numeric < -3650
                     OR (triggered_by->>'observed')::numeric > 3650)
                RETURNING id
            """)).fetchall()
            for row in invalidated:
                conn.execute(text("""
                    INSERT INTO incident_events (incident_id, event_type, at, actor, detail)
                    VALUES (:i, 'resolved', NOW(), 'system',
                            '{"motivo": "aberto com uma métrica implausível, fora da faixa de sanidade de datas — defeito corrigido na Sessão 4, T1"}'::jsonb)
                """), {"i": row[0]})
            conn.execute(text("DELETE FROM alembic_version"))
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
                {"v": "021"},
            )
            logger.info("Migration 021 aplicada com sucesso (%d incidente(s) invalidado(s))", len(invalidated))
            current = {"021"}

        if "021" in current and "022" not in current:
            logger.info("Aplicando migration 021 → 022 (link de leitura do relatório + modo observação, Sessão 4 T9/T12)...")
            conn.execute(text("""
                CREATE TABLE IF NOT EXISTS report_shares (
                    token       VARCHAR(64) PRIMARY KEY,
                    incident_id INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
                    created_by  VARCHAR(100) NOT NULL,
                    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
                    expires_at  TIMESTAMP NOT NULL
                )
            """))
            conn.execute(text("""
                CREATE INDEX IF NOT EXISTS ix_report_shares_incident ON report_shares (incident_id)
            """))
            conn.execute(text("""
                ALTER TABLE servers
                    ADD COLUMN IF NOT EXISTS observation_mode BOOLEAN NOT NULL DEFAULT FALSE
            """))
            conn.execute(text("DELETE FROM alembic_version"))
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
                {"v": "022"},
            )
            logger.info("Migration 022 aplicada com sucesso")
            current = {"022"}

        if "022" in current and "023" not in current:
            logger.info("Aplicando migration 022 → 023 (canal de alerta global com override por servidor, Sessão 4 T10)...")
            for column in ("email_override", "telegram_override", "webhook_override"):
                conn.execute(text(f"""
                    ALTER TABLE alert_settings
                        ADD COLUMN IF NOT EXISTS {column} BOOLEAN NOT NULL DEFAULT FALSE
                """))

            # Quem já tinha canal configurado direto no servidor não pode
            # perder o alerta ao ligar a herança: esses registros nascem
            # com o override do canal correspondente LIGADO, preservando
            # exatamente o que já disparava. A herança do global passa a
            # valer só para servidor que nunca teve aquele canal
            # configurado — e para os que vierem depois.
            promoted = conn.execute(text("""
                UPDATE alert_settings SET
                    email_override    = (email_enabled OR email_to <> '' OR smtp_password <> '' OR resend_api_key <> ''),
                    telegram_override = (telegram_enabled OR telegram_bot_token <> '' OR telegram_chat_id <> ''),
                    webhook_override  = (webhook_url <> '')
                WHERE server_id IS NOT NULL
                RETURNING server_id
            """)).fetchall()

            conn.execute(text("DELETE FROM alembic_version"))
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
                {"v": "023"},
            )
            logger.info("Migration 023 aplicada com sucesso (%d config(s) por servidor avaliada(s))", len(promoted))
            current = {"023"}

        if "023" in current and "024" not in current:
            logger.info("Aplicando migration 023 → 024 (alert_history.incident_id — notificação órfã, Sessão 5)...")
            # O histórico de alertas guardava a referência ao incidente só
            # dentro da string `problem` ("auth_abuse:opened:INC-113").
            # Apagar o incidente deixava a linha para trás, e o painel
            # continuava exibindo um INC-### que não existe mais — foi o
            # que a verificação em navegador viu como "opened repetido de
            # duas a quatro vezes". Com a FK, apagar o incidente apaga as
            # notificações dele.
            conn.execute(text("""
                ALTER TABLE alert_history
                    ADD COLUMN IF NOT EXISTS incident_id INTEGER
                    REFERENCES incidents(id) ON DELETE CASCADE
            """))
            conn.execute(text("""
                CREATE INDEX IF NOT EXISTS ix_alert_history_incident ON alert_history (incident_id)
            """))

            # Retroativo: liga as linhas já gravadas ao incidente cujo
            # display_id aparece no fim de `problem`. As que não casarem
            # (incidente já apagado) são justamente as órfãs — apagadas
            # abaixo, porque referenciam um INC-### que ninguém consegue
            # abrir.
            # `:INC-` não pode aparecer literal no SQL: text() lê `:INC`
            # como bind parameter e o startup morre com "A value is
            # required for bind parameter 'INC'". Vai como parâmetro.
            conn.execute(
                text("""
                    UPDATE alert_history a SET incident_id = i.id
                      FROM incidents i
                     WHERE a.incident_id IS NULL
                       AND a.problem LIKE :pat
                       AND split_part(a.problem, :sep, 2) = i.id::text
                """),
                {"pat": "%:INC-%", "sep": ":INC-"},
            )
            orphans = conn.execute(
                text("""
                    DELETE FROM alert_history
                     WHERE incident_id IS NULL AND problem LIKE :pat
                    RETURNING id
                """),
                {"pat": "%:INC-%"},
            ).fetchall()

            conn.execute(text("DELETE FROM alembic_version"))
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v)"),
                {"v": "024"},
            )
            logger.info("Migration 024 aplicada com sucesso (%d notificação(ões) órfã(s) removida(s))", len(orphans))
            current = {"024"}

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
    # Idempotente e barato — garante o admin do .env como linha real em
    # users em TODO boot, inclusive num banco que ja estava carimbado na
    # versao atual (onde run_migrations retorna cedo e nao chega a semear).
    # Sem isso o login cai no User sintetico id=0 e criar servidor da 500.
    try:
        from .database import engine
        with engine.begin() as _conn:
            _seed_admin_user(_conn)
    except Exception:
        logger.exception("Falha ao garantir o usuario admin (seguindo mesmo assim)")
    logger.info("Banco de dados pronto")

    collector_task = asyncio.create_task(background_collector())
    retention_task = asyncio.create_task(retention_loop())
    weekly_report_task = asyncio.create_task(weekly_report_loop())
    monthly_report_task = asyncio.create_task(monthly_report_loop())
    logger.info(
        "Coletor em background iniciado - quick=%ds, full=%ds",
        settings.quick_interval,
        settings.full_interval,
    )

    yield

    collector_task.cancel()
    retention_task.cancel()
    weekly_report_task.cancel()
    monthly_report_task.cancel()
    for task in (collector_task, retention_task, weekly_report_task, monthly_report_task):
        try:
            await task
        except asyncio.CancelledError:
            pass
    close_all_pooled()
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
    version=APP_VERSION,
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
app.include_router(incidents.router)
app.include_router(reputation.router)
app.include_router(security.router)
app.include_router(history.router)
app.include_router(messages.router)
app.include_router(settings_router.router)


@app.get("/api/health", tags=["meta"])
def health():
    return {"status": "ok", "version": APP_VERSION}


@app.get("/api/version", tags=["meta"])
def version():
    """
    Versão em execução — sem autenticação de propósito: o `upgrade.sh` e o
    rodapé do painel consultam isto para confirmar o que subiu. Não expõe
    nada sensível (versão, sha de build, hora de início, versão do schema).
    """
    return {**version_info(), "schema_version": _SCHEMA_VERSION}
