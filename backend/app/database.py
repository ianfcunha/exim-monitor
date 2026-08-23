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

from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Index, Integer, String, Text, create_engine, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, relationship, sessionmaker
from sqlalchemy.pool import QueuePool

from .config import settings
from .crypto import decrypt_secret

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


class Organization(Base):
    """
    Sessão 3, Tarefa 5 — fronteira open-core: "adicionar org_id e
    contagem de servidores no schema (barato agora, caro depois). Não
    construa billing." Deliberadamente mínima: nenhum plano, limite,
    cobrança ou fluxo de onboarding — só a coluna existindo, pra uma
    eventual feature multi-org/billing não precisar de uma migration
    retroativa numa base de produção já grande. `org_id` em User/Server
    é nullable e não é lido por nenhuma regra de acesso hoje
    (get_servers_for_user() continua usando owner_id) — isto é
    preparação de schema, não uma feature ativa.

    "Contagem de servidores" não vira uma coluna denormalizada aqui de
    propósito (evita o problema de manter um contador sincronizado sem
    nenhum consumidor real ainda) — ver get_org_server_count() abaixo,
    uma consulta simples que qualquer feature futura de billing pode
    chamar quando existir.
    """
    __tablename__ = "organizations"

    id         = Column(Integer, primary_key=True)
    name       = Column(String(200), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


class User(Base):
    """
    Usuário da plataforma.
    role: 'admin' — gerencia servidores e convida membros.
          'viewer' — acesso somente leitura aos servidores do admin que o convidou.
    """
    __tablename__ = "users"

    id                 = Column(Integer, primary_key=True)
    org_id             = Column(Integer, ForeignKey("organizations.id", ondelete="SET NULL"), nullable=True)
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
    # Sessão 3, T5 — mesma preparação de schema de User.org_id, ver
    # Organization acima. Não lido por get_servers_for_user() hoje.
    org_id          = Column(Integer, ForeignKey("organizations.id", ondelete="SET NULL"), nullable=True)
    name            = Column(String(100), nullable=False)
    host            = Column(String(255), nullable=False)
    port            = Column(Integer,     default=22,     nullable=False)
    # T4 (Sessão 1, pós-auditoria): sem default "root" no nível de coluna —
    # o default de fato fica no schema Pydantic (ServerCreate, routers/
    # servers.py), que exige confirm_root=true explícito pra aceitar
    # "root". O default de coluna aqui é só uma rede de segurança pra
    # INSERT bruto (fora da API), não o caminho normal de cadastro.
    ssh_user        = Column(String(100), nullable=False)
    # 'password' ou 'key' — default "key" (era "password")
    ssh_auth_type   = Column(String(20),  default="key", nullable=False)
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
    # T4: última sondagem de capacidade (diag-exim.sh --check, checks
    # cap_*) — persistida a cada /test, pra o painel desabilitar botão
    # de ação com o motivo visível em vez de deixar a ação falhar calada.
    capabilities    = Column(JSONB, nullable=True)
    # Sessão 4, T12 — modo observação: o painel continua coletando e
    # diagnosticando este servidor, mas recusa qualquer ação que o
    # altere. A recusa acontece no backend (routers/actions.py e
    # routers/incidents.py); a interface desabilitar o botão com o motivo
    # é conveniência, não a garantia.
    observation_mode = Column(Boolean, default=False, nullable=False)
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
    # T6 (Sessão 1, pós-auditoria): mesma correção do default em
    # collector.py — nível de coluna é só rede de segurança pra um
    # INSERT fora do caminho normal (que sempre passa severity/problem
    # explícitos); mesmo assim não pode assumir "tudo bem" por padrão.
    severity      = Column(String(20), default="UNKNOWN", nullable=False)
    problem       = Column(String(40), default="UNKNOWN", nullable=False)
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

    # ── Notificação de incidentes (Sessão 2, Tarefa 4) ────────────────────
    # Reaproveita os MESMOS canais acima (telegram/email/webhook) — isto
    # aqui só liga/desliga e ajusta ruído, não duplica configuração de
    # canal. "Configuração de threshold por tipo em formulário simples" —
    # não uma aba "Regras" dedicada.
    incident_notify_critical = Column(Boolean, default=True, nullable=False)
    incident_notify_atencao  = Column(Boolean, default=True, nullable=False)
    # ["auth_abuse", "reputation", ...] — tipos silenciados neste servidor,
    # nenhuma mensagem (nem abertura) sai para eles.
    muted_incident_types = Column(JSONB, default=list, nullable=False)
    # "HH:MM" ou "" (desabilitado) — só se aplica a severidade "atencao";
    # crítico notifica a qualquer hora. Comparação em UTC (sem timezone
    # por servidor no schema hoje — limitação conhecida, documentada em
    # incident_notify.py).
    night_silence_start = Column(String(5), default="", nullable=False)
    night_silence_end   = Column(String(5), default="", nullable=False)

    # ── Custo estimado (Sessão 3, Tarefa 1) ─────────────────────────────
    # NULL = não configurado = nenhuma estimativa financeira é exibida em
    # lugar nenhum (instrução explícita: "não invente valor em reais
    # automaticamente" — um número inventado destrói credibilidade na
    # primeira reunião). Só depois de preenchido aqui é que
    # incident_impact.py calcula e rotula como "estimativa".
    cost_per_sysadmin_hour_brl = Column(Float, nullable=True)
    cost_per_ticket_brl        = Column(Float, nullable=True)

    # ── Relatório mensal (Sessão 3, Tarefa 3) ───────────────────────────
    # Mesmo padrão de weekly_report_* acima — um registro com server_id
    # preenchido envia o relatório DAQUELE servidor; o registro global
    # (server_id nulo, id=1) envia o relatório DA FROTA inteira. Persistido
    # (não em memória) pelo mesmo motivo do semanal: sobreviver a um
    # restart do backend sem perder o controle de quando foi o último
    # envio do mês.
    monthly_report_enabled      = Column(Boolean, default=False, nullable=False)
    monthly_report_last_sent_at = Column(DateTime, nullable=True)


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
    # T8 (Sessão 1, pós-auditoria): "quem, quando, o plano, o resultado
    # real e como reverter" — plan_id referencia o ActionPlan usado (T3);
    # revert_hint é o comando/incidente pra desfazer esta ação específica
    # (ex.: "restore-quarantine:<incidente>"), null quando a ação não
    # altera nada (check-deliverability) ou não tem reversão de um clique.
    plan_id     = Column(String(36),  nullable=True)
    revert_hint = Column(String(300), nullable=True)
    # Sessão 2, Tarefa 5: liga a ação executada ao incidente que a
    # sugeriu, quando aplicável — "Aplicar correção sugerida" na tela de
    # Triagem passa isto junto (rota /fix/apply); ações disparadas fora
    # do fluxo de incidente (ActionPanel comum) deixam null. SET NULL (não
    # CASCADE) pela mesma razão de server_id acima: auditoria sobrevive
    # à remoção do incidente.
    incident_id = Column(Integer, ForeignKey("incidents.id", ondelete="SET NULL"), nullable=True)


def record_action_history(
    db,
    *,
    server_id: Optional[int],
    actor: str,
    action: str,
    param: Optional[str],
    success: bool,
    message: Optional[str],
    plan_id: Optional[str] = None,
    revert_hint: Optional[str] = None,
    incident_id: Optional[int] = None,
) -> None:
    """Persiste uma ação executada — incluindo tentativas negadas (permissão
    insuficiente, rate limit, plano inválido) e falhas de conexão, não só
    execuções bem-sucedidas (T8, Sessão 1, pós-auditoria). Nunca levanta —
    falha de auditoria não deve derrubar a resposta da ação em si (o
    resultado real já foi obtido do servidor remoto antes desta chamada,
    quando aplicável)."""
    try:
        db.add(ActionHistory(
            server_id=server_id, actor=actor, action=action,
            param=param, success=success, message=message,
            plan_id=plan_id, revert_hint=revert_hint, incident_id=incident_id,
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


class Incident(Base):
    """
    Sessão 2 — "o incidente é o produto": em vez de um snapshot mudo que
    o próximo ciclo de coleta reescreve por cima, um incidente é uma
    entidade com identidade estável (fingerprint) e uma máquina de
    estados explícita (ver IncidentEvent) — cada transição fica
    registrada, nunca só um campo sobrescrito.

    Exatamente 3 tipos críticos + 1 tipo atenção-only (ver
    detectors.py): auth_abuse, reputation, queue_stuck (críticos) e
    dest_deferral (sempre atenção — é transitório, não indica um
    problema deste servidor).

    Agravamento (mesma fingerprint, métrica pior) NÃO cria um incidente
    novo — adiciona um evento "escalated" a este (ver incident_engine.py:
    evaluate_incidents()).
    """
    __tablename__ = "incidents"
    __table_args__ = (
        Index("ix_incidents_fingerprint", "fingerprint"),
        Index("ix_incidents_status", "status"),
        Index("ix_incidents_server_status", "server_id", "status"),
    )

    id        = Column(Integer, primary_key=True)
    server_id = Column(Integer, ForeignKey("servers.id", ondelete="CASCADE"), nullable=False)
    type      = Column(String(30), nullable=False)  # auth_abuse | reputation | queue_stuck | dest_deferral
    severity  = Column(String(20), nullable=False)  # critico | atencao
    status    = Column(String(20), default="aberto", nullable=False)  # aberto | em_observacao | mitigado | resolvido

    # Sessão 4, T4: subtipo distingue problemas genuinamente diferentes
    # do mesmo tipo sobre a mesma entidade — o IP de saída listado numa
    # blocklist e o certificado daquele host vencendo são incidentes
    # distintos, e sem isto se fundiriam ao normalizar a entidade.
    subtype   = Column(String(30), nullable=False, default="")

    # tipo + subtipo + servidor + entidade NORMALIZADA — chave estável de
    # deduplicação (ver detectors.py::make_fingerprint). A normalização
    # existe porque um IPv4 chegava rotulado ora como "ip:", ora como
    # "domain:", gerando dois incidentes críticos para o mesmo endereço.
    # `entity` fica também em coluna própria (não só embutida na string)
    # porque a interface agrupa incidentes por entidade e servidor.
    fingerprint = Column(String(300), nullable=False)
    entity      = Column(String(300), nullable=False)

    first_seen  = Column(DateTime, default=datetime.utcnow, nullable=False)
    last_seen   = Column(DateTime, default=datetime.utcnow, nullable=False)
    resolved_at = Column(DateTime, nullable=True)
    resolution  = Column(String(20), nullable=True)  # manual | automatica | expirada

    evidence      = Column(JSONB, nullable=True)  # linhas de log que provam o diagnóstico
    metrics       = Column(JSONB, nullable=True)  # números do incidente
    suggested_fix = Column(JSONB, nullable=True)  # {"description": "...", "action": {"action":"block-ip","param":"1.2.3.4"}}
    triggered_by  = Column(JSONB, nullable=True)  # {"rule": "...", "threshold": ..., "observed": ...}

    # Anti-ruído (Tarefa 4): silenciado até este instante — cobre tanto
    # "silenciar este incidente" quanto a janela de silêncio noturno para
    # severidade atenção (calculada e aplicada em incident_notify.py).
    silenced_until = Column(DateTime, nullable=True)

    # Ciclos full consecutivos em que o detector não encontrou mais esta
    # fingerprint — motor de resolução automática (RESOLVE_AFTER_CLEAN_CYCLES
    # em incident_engine.py). Zera a cada reaparecimento.
    consecutive_clean = Column(Integer, default=0, nullable=False)

    # Sessão 4, T1/T3: desde quando a checagem que sustenta este incidente
    # não pode mais ser feita. Um incidente nessa situação NÃO é resolvido
    # automaticamente (não sabemos que acabou) e NÃO fica exibido como se
    # ainda estivesse confirmado — a interface mostra "não foi possível
    # reverificar desde X". NULL = a checagem está respondendo normalmente.
    unverified_since = Column(DateTime, nullable=True)

    # Sessão 3, Tarefa 1: impacto do incidente — mensagens/contas/domínios
    # afetados, tempo em aberto, queda na taxa de entrega e (só se
    # configurado) estimativa financeira. NULL enquanto aberto (calculado
    # ao vivo em incident_impact.py::compute_impact() a cada leitura, sem
    # gravar); congelado aqui em exatamente um lugar — o momento em que o
    # status vira "resolvido" (routers/incidents.py e incident_engine.py,
    # nunca em outro ponto) — pra não recalcular pra trás com dado que já
    # não existe mais (fila que já foi limpa, log que já rotacionou).
    impact = Column(JSONB, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    server = relationship("Server")
    events = relationship(
        "IncidentEvent", back_populates="incident",
        order_by="IncidentEvent.at", cascade="all, delete-orphan",
    )

    @property
    def display_id(self) -> str:
        return f"INC-{self.id}"


class IncidentEvent(Base):
    """
    Máquina de estados do incidente — append-only, cada transição é um
    evento imutável, nunca um campo sobrescrito por cima. `actor` é
    "system" para transições automáticas do motor de detecção.
    """
    __tablename__ = "incident_events"
    __table_args__ = (
        Index("ix_incident_events_incident", "incident_id"),
    )

    id          = Column(Integer, primary_key=True)
    incident_id = Column(Integer, ForeignKey("incidents.id", ondelete="CASCADE"), nullable=False)
    # opened | escalated | ack | silenced | mitigated | resolved | reopened
    event_type  = Column(String(20), nullable=False)
    at          = Column(DateTime, default=datetime.utcnow, nullable=False)
    actor       = Column(String(100), nullable=False, default="system")
    detail      = Column(JSONB, nullable=True)

    incident = relationship("Incident", back_populates="events")


def record_incident_event(db, incident: "Incident", event_type: str, actor: str = "system",
                          detail: Optional[dict] = None) -> "IncidentEvent":
    """Registra uma transição de estado do incidente. Não commita —
    quem chama já está numa transação que também atualiza `incident`
    (status/last_seen/etc.), commitados juntos atomicamente."""
    ev = IncidentEvent(incident_id=incident.id, event_type=event_type, actor=actor, detail=detail)
    db.add(ev)
    return ev


class ReportShare(Base):
    """
    Sessão 4, Tarefa 9 — link de leitura para o relatório de um
    incidente, com validade.

    O relatório é o artefato que o dono do host encaminha ao cliente
    dele; o cliente não tem conta no painel. Um token de leitura resolve
    isso sem inventar um sistema de convites: dá acesso a UM relatório,
    expira, e pode ser revogado apagando a linha.

    O token é o identificador — não há segredo separado, então ele é
    gerado com secrets.token_urlsafe (não com um contador ou um uuid1
    previsível) e o link só deve ser compartilhado com quem pode ler o
    incidente.
    """
    __tablename__ = "report_shares"
    __table_args__ = (
        Index("ix_report_shares_incident", "incident_id"),
    )

    token       = Column(String(64), primary_key=True)
    incident_id = Column(Integer, ForeignKey("incidents.id", ondelete="CASCADE"), nullable=False)
    created_by  = Column(String(100), nullable=False)
    created_at  = Column(DateTime, default=datetime.utcnow, nullable=False)
    expires_at  = Column(DateTime, nullable=False)


class CheckResult(Base):
    """
    Sessão 4, Tarefas 1/3/7 — o registro de CADA verificação feita, e não
    só das que viraram incidente.

    Existe por três motivos que se sustentam mutuamente:

    1. O quarto estado (T1). Uma checagem que não pôde ser feita precisa
       de um lugar para existir. Ela não é um incidente (não abre nada) e
       não é ausência de problema (não pode contar como saudável) — é uma
       linha aqui com status "desconhecido" e o motivo, que a interface
       mostra como "não foi possível verificar — X".

    2. Histerese (T3). Decidir "listado" a partir de uma única amostra foi
       o que produziu um IP entrando e saindo da mesma blocklist doze
       vezes em doze horas. Abrir exige N leituras positivas consecutivas
       e fechar exige M negativas — o que só é possível com o histórico
       das leituras persistido, independente de haver incidente aberto.

    3. Evidência por tipo (T7). Para um incidente de reputação a
       evidência nunca vai estar no mainlog: ela é a zona consultada, a
       resposta bruta, o resolver e o horário de cada uma das últimas N
       checagens. É exatamente o que `detail` guarda.

    Append-only; a poda é por idade (ver run_retention em database.py).
    """
    __tablename__ = "check_results"
    __table_args__ = (
        Index("ix_check_results_lookup", "server_id", "check_key", "observed_at"),
    )

    id         = Column(Integer, primary_key=True)
    server_id  = Column(Integer, ForeignKey("servers.id", ondelete="CASCADE"), nullable=False)
    check_key  = Column(String(100), nullable=False)   # ex.: "reputation.blocklist", "reputation.cert"
    label      = Column(String(120), nullable=False)   # rótulo legível, pt-BR
    status     = Column(String(20),  nullable=False)   # ok | alerta | critico | desconhecido
    reason     = Column(Text, nullable=False, default="")
    detail     = Column(JSONB, nullable=True)
    observed_at = Column(DateTime, default=datetime.utcnow, nullable=False)


def record_check_result(db, server_id: int, outcome: dict) -> "CheckResult":
    """Grava uma checagem. Não commita — o motor de incidentes fecha a
    transação junto com as mudanças de estado do mesmo ciclo."""
    row = CheckResult(
        server_id=server_id,
        check_key=outcome["key"],
        label=outcome.get("label") or outcome["key"],
        status=outcome["status"],
        reason=(outcome.get("reason") or "")[:2000],
        detail=outcome.get("detail") or None,
    )
    db.add(row)
    return row


def get_latest_check_results(db, server_id: int) -> list:
    """A leitura mais recente de cada check_key deste servidor — o que a
    interface mostra como "estado das verificações"."""
    rows = (
        db.query(CheckResult)
        .filter(CheckResult.server_id == server_id)
        .order_by(CheckResult.observed_at.desc(), CheckResult.id.desc())
        .limit(200)
        .all()
    )
    latest = {}
    for r in rows:
        latest.setdefault(r.check_key, r)
    return list(latest.values())


def get_check_history(db, server_id: int, check_key: str, limit: int = 12) -> list:
    """Últimas N leituras de uma checagem — base da histerese (T3) e da
    evidência de incidentes de reputação (T7)."""
    return (
        db.query(CheckResult)
        .filter(CheckResult.server_id == server_id, CheckResult.check_key == check_key)
        .order_by(CheckResult.observed_at.desc(), CheckResult.id.desc())
        .limit(limit)
        .all()
    )


class DetectorConfig(Base):
    """
    Sessão 2, Tarefa 2: "threshold configurável" por tipo de detector e
    por servidor — sobrescreve DEFAULT_THRESHOLDS[type] (detectors.py)
    campo a campo (só as chaves presentes aqui substituem; o resto usa o
    padrão). Deliberadamente plano/genérico (JSONB, sem uma aba
    "Regras" dedicada) — formulário simples por tipo, como pedido.
    """
    __tablename__ = "detector_config"
    __table_args__ = (
        Index("ix_detector_config_server_type", "server_id", "type", unique=True),
    )

    id         = Column(Integer, primary_key=True)
    server_id  = Column(Integer, ForeignKey("servers.id", ondelete="CASCADE"), nullable=False)
    type       = Column(String(30), nullable=False)
    thresholds = Column(JSONB, nullable=False, default=dict)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


def get_detector_config_overrides(db, server_id: int, detector_type: str) -> dict:
    """Retorna só os overrides salvos (dict vazio se nunca configurado) —
    detectors.py._cfg() já sabe fazer merge com DEFAULT_THRESHOLDS."""
    row = (
        db.query(DetectorConfig)
        .filter(DetectorConfig.server_id == server_id, DetectorConfig.type == detector_type)
        .first()
    )
    return row.thresholds if row else {}


def save_detector_config_overrides(db, server_id: int, detector_type: str, thresholds: dict) -> "DetectorConfig":
    row = (
        db.query(DetectorConfig)
        .filter(DetectorConfig.server_id == server_id, DetectorConfig.type == detector_type)
        .first()
    )
    if row is None:
        row = DetectorConfig(server_id=server_id, type=detector_type, thresholds=thresholds)
        db.add(row)
    else:
        row.thresholds = thresholds
    db.commit()
    db.refresh(row)
    return row


class BaselineMetric(Base):
    """
    Sessão 2, Tarefa 3: histórico horário por servidor E por conta, para
    comparar cada coisa contra a própria história — sem isto todo
    threshold é fixo, gera alarme falso na primeira semana e o cliente
    desliga o alerta (a forma real de morrer aqui, por isso a ênfase).

    Uma linha por (server_id, entity, metric, hour_of_day). `entity` é
    "" para métricas de nível de servidor (ex.: queue_total) e o
    identificador da conta (ex.: "login:user@dominio.com") para métricas
    por conta (ex.: auth_volume).

    `samples` guarda até BASELINE_MAX_DAYS (30) pontos, um por dia
    (mais recente sobrescreve o do mesmo dia — ver baseline.py:
    record_sample()), como [{"day": "2026-08-21", "value": 42.0}, ...].
    `mean`/`stddev` são cache calculado a cada gravação (evita
    recalcular em toda leitura de detector, que roda a cada ciclo full).
    """
    __tablename__ = "baseline_metrics"
    __table_args__ = (
        Index("ix_baseline_metrics_lookup", "server_id", "entity", "metric", "hour_of_day", unique=True),
    )

    id          = Column(Integer, primary_key=True)
    server_id   = Column(Integer, ForeignKey("servers.id", ondelete="CASCADE"), nullable=False)
    entity      = Column(String(300), nullable=False, default="")
    metric      = Column(String(50),  nullable=False)
    hour_of_day = Column(Integer,     nullable=False)  # 0-23, UTC

    samples = Column(JSONB, nullable=False, default=list)
    mean    = Column(Float, nullable=True)
    stddev  = Column(Float, nullable=True)

    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


def get_user_by_email(db, email: str):
    return db.query(User).filter(User.email == email).first()


def get_user_by_username(db, username: str):
    return db.query(User).filter(User.username == username).first()


def get_servers_for_user(db, user: User):
    """
    Admin: retorna seus próprios servidores.
    Viewer: retorna os servidores do admin que o convidou.

    Ordem fixa por id: sem ORDER BY o Postgres devolvia a frota em ordem
    variável entre chamadas, o que trocava o servidor pré-selecionado no
    `?server=` a cada recarga da interface.
    """
    owner_id = user.id if user.role == "admin" else user.invited_by
    return (
        db.query(Server)
        .filter(Server.owner_id == owner_id, Server.is_enabled == True)
        .order_by(Server.id)
        .all()
    )


def get_server_owned_by(db, server_id: int, user: User):
    """Retorna o servidor se o usuário tem acesso a ele, None caso contrário."""
    owner_id = user.id if user.role == "admin" else user.invited_by
    return db.query(Server).filter(Server.id == server_id, Server.owner_id == owner_id).first()


def get_org_server_count(db, org_id: int) -> int:
    """Sessão 3, T5 — consulta simples, não um contador denormalizado
    (ver Organization). Sem consumidor hoje; existe pra uma feature
    futura de billing por servidor não precisar reinventar isto."""
    return db.query(Server).filter(Server.org_id == org_id).count()


def build_server_cfg(s: Server) -> dict:
    """
    Monta o dict de configuração SSH para passar ao ssh.py — fonte única
    (T6, Sessão 1, pós-auditoria: antes cada router — servers.py,
    security.py — e collector.py duplicavam essa mesma construção,
    cada um com sua própria chamada a decrypt_secret()).

    Levanta SecretDecryptionError (ver crypto.py) se o segredo salvo não
    puder ser decriptografado — não retorna um cfg com senha vazia
    silenciosamente. Quem chama decide como reportar isso (servers.py
    marca ssh_status="credential_error"; collector.py pula o servidor
    sem derrubar a coleta dos outros).
    """
    return {
        "host":                 s.host,
        "port":                 s.port,
        "ssh_user":             s.ssh_user,
        "ssh_auth_type":        s.ssh_auth_type,
        "ssh_secret":           decrypt_secret(s.ssh_secret),
        "script_path":          s.script_path,
        "host_key_fingerprint": s.ssh_host_key_fingerprint,
    }


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
