"""
Banco de dados PostgreSQL via SQLAlchemy 2.

Modelos:
  - Snapshot      : serie temporal de diagnosticos coletados
  - AlertSettings : configuracao de alertas (singleton — sempre id=1)
"""
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Index, Integer, String, create_engine
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from sqlalchemy.pool import QueuePool

from .config import settings

engine = create_engine(
    settings.database_url,
    poolclass=QueuePool,
    pool_size=5,
    max_overflow=10,
    pool_pre_ping=True,
    pool_recycle=1800,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


class Snapshot(Base):
    __tablename__ = "snapshots"
    __table_args__ = (
        Index("ix_snapshots_ts_brin", "timestamp", postgresql_using="brin"),
        Index("ix_snapshots_mode_ts", "mode", "timestamp"),
        Index("ix_snapshots_severity", "severity"),
    )

    id            = Column(Integer, primary_key=True, index=True)
    timestamp     = Column(DateTime, default=datetime.utcnow, nullable=False)
    mode          = Column(String(10), default="full", nullable=False)
    queue_total   = Column(Integer,    default=0,        nullable=False)
    severity      = Column(String(20), default="OK",     nullable=False)
    problem       = Column(String(40), default="NORMAL", nullable=False)
    delivered     = Column(Integer,    default=0,        nullable=False)
    rejected      = Column(Integer,    default=0,        nullable=False)
    deferred      = Column(Integer,    default=0,        nullable=False)
    recent_sends  = Column(Integer,    default=0,        nullable=False)
    data          = Column(JSONB, nullable=True)


class AlertSettings(Base):
    """
    Configuracao de alertas — singleton (sempre id=1).
    Editavel via UI sem reiniciar o servidor.
    """
    __tablename__ = "alert_settings"

    id = Column(Integer, primary_key=True, default=1)

    # ── E-mail ───────────────────────────────────────────────────────────
    email_enabled  = Column(Boolean, default=False, nullable=False)
    email_to       = Column(String(255), default="", nullable=False)
    smtp_host      = Column(String(255), default="smtp.sendgrid.net", nullable=False)
    smtp_port      = Column(Integer,     default=587, nullable=False)
    smtp_user      = Column(String(255), default="apikey", nullable=False)
    smtp_password  = Column(String(500), default="", nullable=False)
    smtp_from      = Column(String(255), default="alertas@exim-monitor.io", nullable=False)
    smtp_tls       = Column(Boolean,     default=True, nullable=False)

    # ── Resend ───────────────────────────────────────────────────────────
    # Quando preenchido, substitui SMTP pelo Resend API
    resend_api_key = Column(String(500), default="", nullable=False)

    # ── Telegram ─────────────────────────────────────────────────────────
    telegram_enabled   = Column(Boolean,     default=False, nullable=False)
    telegram_bot_token = Column(String(500), default="", nullable=False)
    telegram_chat_id   = Column(String(100), default="", nullable=False)

    # ── Thresholds ───────────────────────────────────────────────────────
    # Severidade minima para disparar alerta: "HIGH" ou "CRITICAL"
    severity_threshold  = Column(String(20), default="HIGH",  nullable=False)
    # Fila acima deste valor dispara alerta independente de severidade (0 = desabilitado)
    queue_threshold     = Column(Integer,    default=0,       nullable=False)
    # Cooldown em minutos — evita flood de alertas (mesmo evento)
    cooldown_minutes    = Column(Integer,    default=30,      nullable=False)


class AlertHistory(Base):
    """
    Histórico de alertas disparados — append-only.
    Retenção: 90 dias.
    """
    __tablename__ = "alert_history"
    __table_args__ = (
        Index("ix_alert_history_ts", "sent_at"),
    )

    id         = Column(Integer, primary_key=True)
    sent_at    = Column(DateTime, default=datetime.utcnow, nullable=False)
    channel    = Column(String(20),  nullable=False)   # 'email' | 'telegram'
    severity   = Column(String(20),  nullable=False)
    problem    = Column(String(200), nullable=False)
    queue_total= Column(Integer,     nullable=False, default=0)
    success    = Column(Boolean,     nullable=False, default=True)
    error_msg  = Column(String(500), nullable=True)


def get_alert_settings(db) -> AlertSettings:
    """Retorna o registro singleton, criando com defaults se nao existir."""
    cfg = db.get(AlertSettings, 1)
    if cfg is None:
        cfg = AlertSettings(id=1)
        db.add(cfg)
        db.commit()
        db.refresh(cfg)
    return cfg


def create_tables() -> None:
    Base.metadata.create_all(bind=engine)


# ── Retenção de snapshots ──────────────────────────────────────────────────────

def run_retention() -> dict:
    """
    Limpeza periódica da tabela snapshots para evitar crescimento ilimitado.

    Política:
      - Snapshots 'quick' com mais de 7 dias → removidos
        (mantemos apenas 'full' para o histórico de médio prazo)
      - Todos os snapshots com mais de 90 dias → removidos

    Retorna dict com contagens para logging.
    """
    from datetime import datetime, timedelta

    cutoff_quick = datetime.utcnow() - timedelta(days=7)
    cutoff_all   = datetime.utcnow() - timedelta(days=90)

    db = SessionLocal()
    try:
        deleted_quick = (
            db.query(Snapshot)
            .filter(Snapshot.timestamp < cutoff_quick, Snapshot.mode == "quick")
            .delete(synchronize_session=False)
        )
        deleted_old = (
            db.query(Snapshot)
            .filter(Snapshot.timestamp < cutoff_all)
            .delete(synchronize_session=False)
        )
        db.commit()
    finally:
        db.close()

    return {"deleted_quick_7d": deleted_quick, "deleted_all_90d": deleted_old}


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
