"""
Pacote de diagnóstico — o que o suporte precisa saber, sem uma ida e volta.

O chamado típico começa em "o painel não está alertando" e gasta três
mensagens até descobrir versão, estado do coletor e se o canal de alerta
estava sequer configurado. Este módulo monta tudo isso de uma vez, num
arquivo que o cliente baixa e anexa.

────────────────────────────────────────────────────────────────────────────
Duas garantias, porque este arquivo SAI da máquina do cliente
────────────────────────────────────────────────────────────────────────────

1. SEGREDO NENHUM, NUNCA.

   Não basta lembrar de omitir cada campo — a omissão que se esquece é
   justamente a que vaza. Então há duas camadas: os campos sensíveis não
   são colocados no dicionário, E o JSON serializado passa por
   `scrub_secrets()`, que troca por «removido» qualquer ocorrência literal
   dos segredos conhecidos (chave Fernet, JWT, senha do banco, senha do
   admin, token da licença, credenciais de canal de alerta) e qualquer
   token Fernet (`gAAAAA...`). Se um campo novo entrar amanhã carregando
   um segredo por engano, a segunda camada ainda pega.

2. DADO PESSOAL PSEUDONIMIZADO.

   As linhas de mainlog que provam um incidente carregam remetente e
   destinatário. Num painel de hospedagem, esses são os clientes finais
   do cliente — pessoas naturais, sob LGPD, que não têm relação nenhuma
   conosco e nunca consentiram com nada.

   A regra: **a parte local do endereço vira pseudônimo, o domínio fica.**

       joao.silva@empresa.com.br  →  conta#7f2a91@empresa.com.br

   Isso preserva os dois sinais que o suporte realmente usa — "para qual
   domínio as mensagens estão atrasando" e "é sempre o mesmo remetente
   reincidindo" — e descarta a identidade. Domínios, IPs e hostnames
   ficam: sozinhos não identificam pessoa, e sem eles o pacote não
   diagnostica nada.

   O pseudônimo é HMAC com uma chave que já existe na instalação e nunca
   sai dela, então é estável entre pacotes do MESMO painel (o suporte
   consegue dizer "é a mesma conta do chamado passado") e inútil para
   correlacionar com qualquer outra instalação. Como é HMAC com chave
   secreta, não dá para reverter por dicionário de e-mails — o que uma
   hash simples permitiria.
"""
import hashlib
import hmac
import json
import logging
import platform
import re
import sys
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# Quantidade de cada coisa. O pacote é para diagnosticar, não para
# auditar: mais que isto vira um arquivo que ninguém abre.
MAX_INCIDENTES = 25
MAX_LINHAS_EVIDENCIA = 15
MAX_ALERTAS = 40
MAX_CHECAGENS = 60

_EMAIL_RE = re.compile(r"([A-Za-z0-9._%+\-]+)@([A-Za-z0-9.\-]+\.[A-Za-z]{2,})")
_FERNET_RE = re.compile(r"gAAAAA[A-Za-z0-9_\-=]{20,}")

REMOVIDO = "«removido»"


# ── Pseudonimização ────────────────────────────────────────────────────────

def _pseudo_key() -> bytes:
    """
    Chave do HMAC. Deriva do JWT_SECRET (e não da SSH_ENCRYPTION_KEY) de
    propósito: a chave Fernet é o segredo mais valioso da instalação e não
    tem por que ser usada para mais nada. O prefixo de domínio separa este
    uso de qualquer outro que o JWT_SECRET tenha.
    """
    from .config import settings

    return hashlib.sha256(
        b"mailiq-diagnostico-pseudonimo:" + settings.jwt_secret.encode("utf-8")
    ).digest()


def pseudonymize(texto: Optional[str]) -> Optional[str]:
    """Troca a parte local de cada e-mail por um pseudônimo estável."""
    if not texto:
        return texto
    chave = _pseudo_key()

    def troca(m: "re.Match") -> str:
        local, dominio = m.group(1), m.group(2)
        digest = hmac.new(chave, local.lower().encode("utf-8"), hashlib.sha256).hexdigest()
        return f"conta#{digest[:6]}@{dominio}"

    return _EMAIL_RE.sub(troca, texto)


# ── Remoção de segredos ────────────────────────────────────────────────────

def _known_secrets() -> List[str]:
    """
    Valores que jamais podem aparecer no pacote. Lidos das configurações e
    do banco (credenciais de canal são editáveis pela UI, então não estão
    no .env).
    """
    from .config import settings

    valores = [
        settings.ssh_encryption_key,
        settings.jwt_secret,
        settings.admin_password,
        settings.mailiq_license,
        settings.ssh_password,
    ]
    # Senha do Postgres vive dentro da DATABASE_URL.
    m = re.match(r"^[a-z+]+://[^:/@]+:([^@]+)@", settings.database_url or "")
    if m:
        valores.append(m.group(1))

    try:
        from .database import AlertSettings, SessionLocal

        db = SessionLocal()
        try:
            for cfg in db.query(AlertSettings).all():
                valores += [
                    cfg.smtp_password, cfg.resend_api_key,
                    cfg.telegram_bot_token, cfg.webhook_secret,
                ]
        finally:
            db.close()
    except Exception:
        logger.exception("Não consegui ler as credenciais de canal para a limpeza")

    # Valores curtos demais produziriam substituições absurdas no texto
    # (um segredo de 3 caracteres casaria em qualquer lugar). Segredo real
    # nunca é curto assim; o que é curto aqui é placeholder de instalação
    # incompleta, e placeholder não é segredo.
    return sorted({v for v in valores if v and len(v) >= 8}, key=len, reverse=True)


def scrub_secrets(texto: str) -> str:
    """Segunda camada: remove segredos por VALOR, não por nome do campo."""
    for segredo in _known_secrets():
        if segredo in texto:
            logger.warning(
                "Um segredo apareceu no pacote de diagnóstico e foi removido na "
                "limpeza final — algum campo novo está vazando; corrija a origem."
            )
            texto = texto.replace(segredo, REMOVIDO)
    # Qualquer token Fernet (segredo SSH cifrado), mesmo que a chave não
    # bata: continua sendo material criptográfico do cliente.
    return _FERNET_RE.sub(REMOVIDO, texto)


# ── Coleta de cada seção ───────────────────────────────────────────────────

def _iso(dt) -> Optional[str]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _painel() -> Dict[str, Any]:
    from .config import settings
    from .version import version_info

    info = version_info()
    return {
        **info,
        "environment":     settings.environment,
        "quick_interval":  settings.quick_interval,
        "full_interval":   settings.full_interval,
        "jwt_expire_minutes": settings.jwt_expire_minutes,
        "cors_origins":    settings.cors_origins,
        "app_url":         settings.app_url,
        "python":          sys.version.split()[0],
        "plataforma":      platform.platform(),
    }


def _licenca(db) -> Dict[str, Any]:
    from .license import license_status

    lic = license_status(db).to_dict()
    # O token em si nunca entra; to_dict() já não o expõe, mas deixar
    # explícito evita que uma mudança lá vaze por aqui.
    lic.pop("token", None)
    return lic


def _servidores(db) -> List[Dict[str, Any]]:
    from .database import Server

    saida = []
    for s in db.query(Server).order_by(Server.id).all():
        saida.append({
            "id":               s.id,
            "nome":             s.name,
            "host":             s.host,
            "porta":            s.port,
            "ssh_user":         s.ssh_user,
            "ssh_auth_type":    s.ssh_auth_type,
            # Nunca o segredo — só se existe algum cadastrado.
            "tem_segredo_ssh":  bool(s.ssh_secret),
            "host_key_pinada":  bool(s.ssh_host_key_fingerprint),
            "script_path":      s.script_path,
            "habilitado":       s.is_enabled,
            "modo_observacao":  s.observation_mode,
            "ssh_status":       s.ssh_status,
            "ssh_error_msg":    s.ssh_error_msg,
            "ultimo_contato":   _iso(s.last_connected_at),
            "capacidades":      s.capabilities,
            "criado_em":        _iso(s.created_at),
        })
    return saida


def _alertas_config(db) -> List[Dict[str, Any]]:
    """
    Só o ESTADO dos canais, nunca as credenciais. `channel_status()` já
    responde a pergunta que o suporte faz ("estava ligado?" e "estava
    completo?") sem tocar em token nenhum.
    """
    from .alerts import channel_status
    from .database import AlertSettings, Server

    saida = []
    for cfg in db.query(AlertSettings).order_by(AlertSettings.id).all():
        nome = None
        if cfg.server_id:
            srv = db.get(Server, cfg.server_id)
            nome = srv.name if srv else f"(servidor {cfg.server_id} removido)"
        saida.append({
            "server_id":     cfg.server_id,
            "servidor":      nome or "global",
            "canais":        channel_status(cfg),
            "overrides":     {
                "email":    cfg.email_override,
                "telegram": cfg.telegram_override,
                "webhook":  cfg.webhook_override,
            },
            "email_destino_configurado": bool(cfg.email_to),
            "usa_resend":         bool(cfg.resend_api_key),
            "smtp_host":          cfg.smtp_host,
            "smtp_port":          cfg.smtp_port,
            "webhook_configurado": bool(cfg.webhook_url),
            "webhook_assinado":    bool(cfg.webhook_secret),
            "severity_threshold": cfg.severity_threshold,
            "queue_threshold":    cfg.queue_threshold,
            "cooldown_minutes":   cfg.cooldown_minutes,
            "relatorio_semanal":  cfg.weekly_report_enabled,
            "relatorio_semanal_ultimo_envio": _iso(cfg.weekly_report_last_sent_at),
        })
    return saida


def _alertas_recentes(db) -> List[Dict[str, Any]]:
    from .database import AlertHistory

    linhas = (
        db.query(AlertHistory)
        .order_by(AlertHistory.sent_at.desc())
        .limit(MAX_ALERTAS)
        .all()
    )
    return [{
        "enviado_em": _iso(r.sent_at),
        "canal":      r.channel,
        "severidade": r.severity,
        # `problem` carrega o nome da entidade em alguns tipos.
        "problema":   pseudonymize(r.problem),
        "server_id":  r.server_id,
        "sucesso":    r.success,
        "erro":       pseudonymize(r.error_msg),
    } for r in linhas]


def _incidentes(db) -> Dict[str, Any]:
    from .database import Incident

    abertos = ("aberto", "em_observacao", "mitigado")
    por_tipo: Dict[str, int] = {}
    for inc in db.query(Incident).filter(Incident.status.in_(abertos)).all():
        chave = f"{inc.type}/{inc.severity}"
        por_tipo[chave] = por_tipo.get(chave, 0) + 1

    recentes = (
        db.query(Incident).order_by(Incident.last_seen.desc()).limit(MAX_INCIDENTES).all()
    )
    lista = []
    for inc in recentes:
        ev = inc.evidence or {}
        linhas = [pseudonymize(l) for l in (ev.get("lines") or [])[:MAX_LINHAS_EVIDENCIA]]
        lista.append({
            "display_id":  inc.display_id,
            "server_id":   inc.server_id,
            "tipo":        inc.type,
            "subtipo":     inc.subtype,
            "severidade":  inc.severity,
            "status":      inc.status,
            "entidade":    pseudonymize(inc.entity),
            "primeira_vez": _iso(inc.first_seen),
            "ultima_vez":   _iso(inc.last_seen),
            "resolvido_em": _iso(inc.resolved_at),
            "resolucao":    inc.resolution,
            "metricas":     inc.metrics,
            "evidencia": {
                "tipo":   ev.get("kind"),
                "motivo_indisponivel": ev.get("unavailable_reason"),
                "linhas": linhas,
                "linhas_omitidas": max(0, len(ev.get("lines") or []) - MAX_LINHAS_EVIDENCIA),
            },
        })
    return {"abertos_por_tipo": por_tipo, "recentes": lista}


def _checagens(db) -> List[Dict[str, Any]]:
    from .database import CheckResult

    linhas = (
        db.query(CheckResult)
        .order_by(CheckResult.observed_at.desc())
        .limit(MAX_CHECAGENS)
        .all()
    )
    return [{
        "observado_em": _iso(c.observed_at),
        "server_id":    c.server_id,
        "checagem":     c.check_key,
        "rotulo":       c.label,
        "status":       c.status,
        "motivo":       pseudonymize(c.reason),
    } for c in linhas]


def _banco(db) -> Dict[str, Any]:
    from sqlalchemy import text

    tabelas = [
        "action_history", "action_plans", "alert_history", "alert_settings",
        "baseline_metrics", "check_results", "detector_config", "incident_events",
        "incidents", "report_shares", "servers", "snapshots", "users",
    ]
    contagens: Dict[str, Any] = {}
    for t in tabelas:
        try:
            contagens[t] = db.execute(text(f"SELECT count(*) FROM {t}")).scalar()
        except Exception as exc:
            contagens[t] = f"erro: {exc.__class__.__name__}"
    info: Dict[str, Any] = {"contagens": contagens}
    try:
        info["schema_version"] = db.execute(
            text("SELECT version_num FROM alembic_version")
        ).scalar()
        info["tamanho"] = db.execute(
            text("SELECT pg_size_pretty(pg_database_size(current_database()))")
        ).scalar()
        info["postgres"] = (db.execute(text("SHOW server_version")).scalar() or "").split()[0]
    except Exception:
        logger.exception("Falha ao ler metadados do banco para o diagnóstico")
    return info


def _retencao(db) -> Dict[str, Any]:
    """Quanto de histórico existe — responde "isso começou quando?"."""
    from sqlalchemy import func

    from .database import Incident, Snapshot

    def faixa(modelo, coluna):
        try:
            menor, maior = db.query(func.min(coluna), func.max(coluna)).one()
            return {"mais_antigo": _iso(menor), "mais_recente": _iso(maior)}
        except Exception:
            return {"mais_antigo": None, "mais_recente": None}

    return {
        "snapshots": faixa(Snapshot, Snapshot.timestamp),
        "incidentes": faixa(Incident, Incident.first_seen),
    }


# ── Montagem ───────────────────────────────────────────────────────────────

AVISO = (
    "Este arquivo foi gerado pelo painel para ser enviado ao suporte do Mail IQ. "
    "Ele NÃO contém senhas, chaves de criptografia, tokens de bot, credenciais "
    "de e-mail nem os segredos SSH dos servidores monitorados. As partes locais "
    "dos endereços de e-mail que aparecem em linhas de log foram substituídas "
    "por pseudônimos (conta#xxxxxx); os domínios foram mantidos porque são o que "
    "permite diagnosticar problemas de entrega. Confira o conteúdo antes de "
    "enviar — é um arquivo de texto legível."
)


def build_diagnostic_package(db, gerado_por: Optional[str] = None) -> Dict[str, Any]:
    """
    Monta o pacote. Cada seção é isolada: uma que falhe vira um campo de
    erro no lugar dela, em vez de derrubar o pacote inteiro — quem está
    abrindo chamado costuma estar exatamente no momento em que alguma
    coisa está quebrada.
    """
    from .watchdog import collector_health

    secoes = {
        "painel":            lambda: _painel(),
        "licenca":           lambda: _licenca(db),
        "coletor":           lambda: collector_health(),
        "servidores":        lambda: _servidores(db),
        "alertas_config":    lambda: _alertas_config(db),
        "alertas_recentes":  lambda: _alertas_recentes(db),
        "incidentes":        lambda: _incidentes(db),
        "checagens":         lambda: _checagens(db),
        "banco":             lambda: _banco(db),
        "retencao":          lambda: _retencao(db),
    }

    pacote: Dict[str, Any] = {
        "aviso":      AVISO,
        "gerado_em":  datetime.now(timezone.utc).isoformat(),
        "gerado_por": gerado_por,
        "formato":    1,
    }
    for nome, montar in secoes.items():
        try:
            pacote[nome] = montar()
        except Exception as exc:
            logger.exception("Falha ao montar a seção %s do diagnóstico", nome)
            pacote[nome] = {"erro": f"{exc.__class__.__name__}: {exc}"}
    return pacote


def render_diagnostic_json(db, gerado_por: Optional[str] = None) -> str:
    """Pacote serializado e já passado pela limpeza final de segredos."""
    pacote = build_diagnostic_package(db, gerado_por=gerado_por)
    return scrub_secrets(json.dumps(pacote, indent=2, ensure_ascii=False, default=str))
