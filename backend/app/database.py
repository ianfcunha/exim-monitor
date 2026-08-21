"""
Banco de dados PostgreSQL via SQLAlchemy 2.

Modelos:
  - Snapshot      : serie temporal de diagnosticos coletados
  - AlertSettings : configuracao de alertas — um registro "padrao" legado
                    (server_id nulo, id=1) e um registro por servidor
                    (server_id preenchido)
"""
import logging
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Text, create_engine, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, relationship, sessionmaker
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

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


class User(Base):
    """
    Usuário da plataforma.
    role: 'admin' — gerencia servidores e convida membros.
          'viewer' — acesso somente leitura aos servidores do admin que o convidou.
    """
    __tablename__ = "users"

    id                 = Column(Integer, primary_key=True)
    email              = Column(String(255), unique=True, nullable=False)
    username           = Column(String(100), unique=True, nullable=False)
    password_hash      = Column(String(500), nullable=True)   # null enquanto convite pendente
    role               = Column(String(20),  default="admin", nullable=False)  # admin | viewer
    is_active          = Column(Boolean,     default=True,    nullable=False)
    email_verified     = Column(Boolean,     default=False,   nullable=False)
    # Incrementado sempre que o role muda — invalida instantaneamente
    # qualquer JWT ja emitido para este usuario (forca novo login).
    token_version      = Column(Integer,     default=0,       nullable=False)

    # Convite
    invite_token       = Column(String(200), nullable=True, unique=True)
    invite_expires_at  = Column(DateTime,    nullable=True)
    invited_by         = Column(Integer,     ForeignKey("users.id", ondelete="SET NULL"), nullable=True)

    created_at         = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_login_at      = Column(DateTime, nullable=True)

    # Relacionamentos
    servers  = relationship("Server", back_populates="owner", foreign_keys="Server.owner_id")
    invitees = relationship("User",   foreign_keys=[invited_by])


class Server(Base):
    """
    Servidor EXIM gerenciado — pertence a um usuário (owner).
    Viewers do owner têm acesso somente leitura.
    """
    __tablename__ = "servers"
    __table_args__ = (
        Index("ix_servers_owner_id", "owner_id"),
    )

    id              = Column(Integer, primary_key=True)
    owner_id        = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name            = Column(String(100), nullable=False)
    host            = Column(String(255), nullable=False)
    port            = Column(Integer,     default=22,     nullable=False)
    ssh_user        = Column(String(100), default="root", nullable=False)
    # 'password' ou 'key'
    ssh_auth_type   = Column(String(20),  default="password", nullable=False)
    # Fernet-encrypted: senha SSH ou conteúdo da chave privada
    ssh_secret      = Column(String(4000), default="", nullable=False)
    script_path     = Column(String(500),  default="/root/diag-exim.sh", nullable=False)
    # Fingerprint (SHA256, formato ssh-keygen) da chave do host, capturado na
    # primeira conexão bem-sucedida via /test. Null = ainda não confirmado.
    ssh_host_key_fingerprint = Column(String(200), nullable=True)
    is_enabled      = Column(Boolean,      default=True,  nullable=False)
    last_connected_at = Column(DateTime,   nullable=True)
    ssh_status      = Column(String(20),   default="unknown", nullable=False)  # ok | error | timeout | unknown
    ssh_error_msg   = Column(String(500),  nullable=True)
    created_at      = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at      = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    # Relacionamentos
    owner     = relationship("User",     back_populates="servers", foreign_keys=[owner_id])
    snapshots = relationship("Snapshot", back_populates="server")


class Snapshot(Base):
    __tablename__ = "snapshots"
    __table_args__ = (
        Index("ix_snapshots_ts_brin", "timestamp", postgresql_using="brin"),
        Index("ix_snapshots_mode_ts", "mode", "timestamp"),
        Index("ix_snapshots_severity", "severity"),
    )

    id            = Column(Integer, primary_key=True, index=True)
    server_id     = Column(Integer, ForeignKey("servers.id", ondelete="CASCADE"), nullable=True)
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

    server = relationship("Server", back_populates="snapshots")


class AlertSettings(Base):
    """
    Configuracao de alertas.

    server_id nulo (id=1)  : registro "padrao"/legado — usado quando nenhum
                              server_id e informado (retrocompatibilidade
                              com quem so tem um servidor).
    server_id preenchido    : configuracao especifica daquele servidor.

    A coluna `id` NAO tem geracao automatica no banco (ver migration 001 —
    Integer primary_key sem server_default), entao novos registros com
    server_id precisam de um id explicito. Use `get_alert_settings()`, que
    cuida disso, em vez de instanciar AlertSettings diretamente.

    Editavel via UI sem reiniciar o servidor.
    """
    __tablename__ = "alert_settings"

    id        = Column(Integer, primary_key=True, default=1)
    server_id = Column(Integer, ForeignKey("servers.id", ondelete="CASCADE"), nullable=True)

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

    # ── Relatório semanal por e-mail ─────────────────────────────────────
    weekly_report_enabled     = Column(Boolean,  default=False, nullable=False)
    # Persistido (em vez de estado em memória) para o job de envio sobreviver
    # a um restart do backend sem perder o controle de quando foi o último
    # envio e reenviar o relatório fora de hora.
    weekly_report_last_sent_at = Column(DateTime, nullable=True)

    # ── Webhook genérico ─────────────────────────────────────────────────
    webhook_url    = Column(String(500), default="", nullable=False)
    # Se preenchido, assina o payload em HMAC-SHA256 (header X-EximMonitor-Signature)
    webhook_secret = Column(String(500), default="", nullable=False)


class AlertHistory(Base):
    """
    Histórico de alertas disparados — append-only.
    Retenção: 90 dias.

    server_id (nullable, SET NULL) foi adicionado junto da migration 007 —
    sem ele, o relatório semanal por servidor não tinha como saber quais
    alertas eram daquele servidor especificamente (mesma classe de bug do
    AlertSettings antes de ficar por servidor).
    """
    __tablename__ = "alert_history"
    __table_args__ = (
        Index("ix_alert_history_ts", "sent_at"),
    )

    id         = Column(Integer, primary_key=True)
    server_id  = Column(Integer, ForeignKey("servers.id", ondelete="SET NULL"), nullable=True)
    sent_at    = Column(DateTime, default=datetime.utcnow, nullable=False)
    channel    = Column(String(20),  nullable=False)   # 'email' | 'telegram'
    severity   = Column(String(20),  nullable=False)
    problem    = Column(String(200), nullable=False)
    queue_total= Column(Integer,     nullable=False, default=0)
    success    = Column(Boolean,     nullable=False, default=True)
    error_msg  = Column(String(500), nullable=True)


def to_utc_iso(dt: Optional[datetime]) -> Optional[str]:
    """
    Serializa um datetime armazenado como UTC (todo Column(DateTime)
    deste schema usa datetime.utcnow(), nunca datetime.now()) em ISO 8601
    com sufixo Z.

    Sem o Z, new Date(str) no frontend interpreta a string como hora
    LOCAL DO NAVEGADOR em vez de UTC — pra qualquer usuário fora do fuso
    UTC+0 (ex.: Brasil, UTC-3), isso faz o timestamp parecer "no futuro"
    e o painel mostra um "há Xs" negativo.
    """
    return dt.isoformat() + "Z" if dt else None


class ActionHistory(Base):
    """
    Histórico de ações executadas via API — append-only. Fonte central de
    auditoria (actor, ação, parâmetro, servidor, sucesso) sem precisar SSH
    de volta no servidor pra ler /var/log/exim-monitor/actions.log em texto.

    server_id usa SET NULL (não CASCADE) — ao contrário de Snapshot, um
    registro de auditoria deve sobreviver à remoção do servidor.
    """
    __tablename__ = "action_history"
    __table_args__ = (
        Index("ix_action_history_ts", "executed_at"),
    )

    id          = Column(Integer, primary_key=True)
    executed_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    server_id   = Column(Integer, ForeignKey("servers.id", ondelete="SET NULL"), nullable=True)
    actor       = Column(String(100), nullable=False)
    action      = Column(String(50),  nullable=False)
    param       = Column(String(300), nullable=True)
    success     = Column(Boolean,     nullable=False, default=True)
    # TEXT (não VARCHAR(500) — migration 009): before_snapshot de ações
    # destrutivas (amostra de IDs da fila afetada, estado de bloqueio
    # anterior etc.) é anexado aqui pelo router, e não cabia em 500 chars.
    message     = Column(Text, nullable=True)


def record_action_history(
    db,
    *,
    server_id: Optional[int],
    actor: str,
    action: str,
    param: Optional[str],
    success: bool,
    message: Optional[str],
) -> None:
    """Persiste uma ação executada. Nunca levanta — falha de auditoria não
    deve derrubar a resposta da ação em si (o resultado real já foi obtido
    do servidor remoto antes desta chamada)."""
    try:
        db.add(ActionHistory(
            server_id=server_id, actor=actor, action=action,
            param=param, success=success, message=message,
        ))
        db.commit()
    except Exception:
        db.rollback()
        logger.exception("Falha ao persistir action_history (actor=%s action=%s)", actor, action)


class ActionPlan(Base):
    """
    Tarefa 3 (Sessão 1, pós-auditoria): plan()/apply() de verdade —
    plan() gera uma linha aqui (id + preview do que seria feito, sem
    alterar nada no servidor); apply() só executa se o plan_id existir,
    corresponder exatamente à ação/servidor/parâmetro pedidos, não ter
    sido consumido ainda, e não ter mais de 5 minutos (ver
    PLAN_MAX_AGE_SECONDS em routers/actions.py).

    id é o próprio plan_id (uuid4 hex) — também usado como nome do
    incidente de quarentena no script (--incident=<plan_id>), pra um
    plano mapear 1:1 com o que de fato foi quarentenado.
    """
    __tablename__ = "action_plans"
    __table_args__ = (
        Index("ix_action_plans_created_at", "created_at"),
    )

    id          = Column(String(36),  primary_key=True)
    server_id   = Column(Integer, ForeignKey("servers.id", ondelete="SET NULL"), nullable=True)
    actor       = Column(String(100), nullable=False)
    action      = Column(String(50),  nullable=False)
    param       = Column(String(300), nullable=True)
    preview     = Column(JSONB, nullable=True)
    created_at  = Column(DateTime, default=datetime.utcnow, nullable=False)
    consumed_at = Column(DateTime, nullable=True)


def get_user_by_email(db, email: str):
    return db.query(User).filter(User.email == email).first()


def get_user_by_username(db, username: str):
    return db.query(User).filter(User.username == username).first()


def get_servers_for_user(db, user: User):
    """
    Admin: retorna seus próprios servidores.
    Viewer: retorna os servidores do admin que o convidou.
    """
    owner_id = user.id if user.role == "admin" else user.invited_by
    return db.query(Server).filter(Server.owner_id == owner_id, Server.is_enabled == True).all()


def get_server_owned_by(db, server_id: int, user: User):
    """Retorna o servidor se o usuário tem acesso a ele, None caso contrário."""
    owner_id = user.id if user.role == "admin" else user.invited_by
    return db.query(Server).filter(Server.id == server_id, Server.owner_id == owner_id).first()


def get_alert_settings(db, server_id: Optional[int] = None) -> AlertSettings:
    """
    Retorna a configuracao de alertas, criando com defaults se nao existir.

    server_id=None (default): registro "padrao"/legado (id=1, server_id nulo)
    — mantem o comportamento de antes para quem so tem um servidor.

    server_id=<int>: registro daquele servidor especifico. Cada servidor tem
    seus proprios canais/thresholds — nao compartilha config com os demais.
    """
    if server_id is None:
        cfg = db.get(AlertSettings, 1)
        if cfg is None:
            cfg = AlertSettings(id=1)
            db.add(cfg)
            db.commit()
            db.refresh(cfg)
        return cfg

    cfg = db.query(AlertSettings).filter(AlertSettings.server_id == server_id).first()
    if cfg is None:
        # `id` nao tem geracao automatica no banco (ver docstring da classe) —
        # calcula o proximo id manualmente, como o antigo id=1 fixo ja fazia.
        next_id = (db.query(func.coalesce(func.max(AlertSettings.id), 0)).scalar() or 0) + 1
        cfg = AlertSettings(id=next_id, server_id=server_id)
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
