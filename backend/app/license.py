"""
Licença de uso — verificação offline, assinatura Ed25519.

O painel roda na infraestrutura do cliente e não fala com nenhum servidor
de licenciamento: o token carrega os próprios dados assinados, e o backend
só precisa da chave PÚBLICA (embutida aqui) para conferir. Sem chamada de
rede, sem telemetria, sem "phone home" — funciona em rede fechada.

Formato do token (env MAILIQ_LICENSE):

    <payload-base64url>.<assinatura-base64url>

O payload é JSON canônico (chaves ordenadas, sem espaços):

    {"customer": "...", "expires_at": "2027-09-02T00:00:00+00:00",
     "features": [], "issued_at": "...", "license_id": "...",
     "max_servers": 5}

A assinatura cobre os BYTES ASCII do payload já em base64url — não o JSON
re-serializado. Assim a verificação nunca depende de reproduzir byte a byte
a serialização de quem assinou.

Emissão: tools/issue-license.py (a chave privada NÃO mora no repositório).

────────────────────────────────────────────────────────────────────────────
Política — licença "soft", de propósito
────────────────────────────────────────────────────────────────────────────
Licença vencida, inválida ou ausente NUNCA:
  · trava o painel ou o deixa somente-leitura;
  · para o coletor dos servidores já cadastrados;
  · apaga, esconde ou degrada dado nenhum.

A única consequência é recusar o CADASTRO DE NOVOS SERVIDORES, com uma
mensagem que diz o motivo. O cliente é uma hospedagem: derrubar o
monitoramento de e-mail dela por causa de uma fatura seria transformar um
problema comercial em incidente de produção — e o incidente seria nosso.

Instalação sem MAILIQ_LICENSE entra em cortesia: 1 servidor por 30 dias a
partir da data de instalação, para o piloto rodar antes de existir contrato.
"""
import base64
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric import ed25519

logger = logging.getLogger(__name__)

# ── Chave pública de emissão ───────────────────────────────────────────────
# 32 bytes brutos em base64. A privada correspondente fica FORA do
# repositório (ver tools/issue-license.py). Trocar esta constante invalida
# todas as licenças já emitidas.
_PUBLIC_KEY_B64 = "Mq6ZexQXbEPujXyZukO3wbqesuJVjTk8wChJltV3nvg="

# Dias antes do vencimento em que o estado passa a "expiring" — o painel
# começa a avisar aqui, com folga para renovar sem susto.
EXPIRING_WINDOW_DAYS = 14

# Cortesia de instalação sem licença nenhuma.
GRACE_DAYS = 30
GRACE_MAX_SERVERS = 1

STATE_OK = "ok"
STATE_EXPIRING = "expiring"
STATE_EXPIRED = "expired"
STATE_INVALID = "invalid"
STATE_MISSING = "missing"


@dataclass
class LicenseStatus:
    """Estado da licença desta instalação, pronto para a API e para o log."""

    state: str
    detail: str
    customer: str = ""
    license_id: str = ""
    expires_at: Optional[datetime] = None
    max_servers: int = 0
    features: List[str] = field(default_factory=list)
    servers_used: int = 0

    @property
    def valid(self) -> bool:
        """Assinatura confere E ainda está no prazo."""
        return self.state in (STATE_OK, STATE_EXPIRING)

    @property
    def days_left(self) -> Optional[int]:
        if self.expires_at is None:
            return None
        delta = self.expires_at - datetime.now(timezone.utc)
        # Arredonda para baixo: "faltam 0 dias" no último dia, nunca 1.
        return max(0, delta.days) if delta.total_seconds() > 0 else 0

    @property
    def is_grace(self) -> bool:
        return self.state == STATE_MISSING

    def block_reason(self) -> Optional[str]:
        """
        Motivo para recusar o cadastro de um servidor novo, ou None se pode.
        Único ponto que decide bloqueio — a API e a UI leem daqui.
        """
        if self.state == STATE_INVALID:
            return (
                "A licença configurada não pôde ser validada (assinatura não "
                "confere ou o token está truncado). Servidores já cadastrados "
                "seguem sendo monitorados normalmente; apenas o cadastro de "
                "novos está suspenso até a licença ser corrigida."
            )
        if self.state == STATE_EXPIRED:
            # dd/mm/aaaa: esta frase vai inteira para a tela e para o corpo
            # do 403 — data em ISO no meio de texto em português destoa.
            venc = self.expires_at.strftime("%d/%m/%Y") if self.expires_at else "?"
            return (
                f"A licença venceu em {venc}. Servidores já cadastrados seguem "
                "sendo monitorados normalmente; apenas o cadastro de novos está "
                "suspenso até a renovação."
            )
        if self.state == STATE_MISSING and (self.days_left or 0) <= 0:
            return (
                f"Esta instalação está sem licença e o período de cortesia de "
                f"{GRACE_DAYS} dias terminou. O monitoramento do que já está "
                "cadastrado continua; para adicionar servidores, configure "
                "MAILIQ_LICENSE."
            )
        if self.servers_used >= self.max_servers:
            if self.state == STATE_MISSING:
                return (
                    f"O período de cortesia permite {self.max_servers} servidor. "
                    "Para monitorar mais, configure MAILIQ_LICENSE."
                )
            return (
                f"A licença cobre {self.max_servers} servidor(es) e todos já "
                f"estão em uso. Para monitorar mais, fale com o suporte sobre "
                "ampliar o limite."
            )
        return None

    def to_dict(self) -> dict:
        return {
            "state":        self.state,
            "valid":        self.valid,
            "detail":       self.detail,
            "customer":     self.customer,
            "license_id":   self.license_id,
            "expires_at":   self.expires_at.isoformat() if self.expires_at else None,
            "days_left":    self.days_left,
            "max_servers":  self.max_servers,
            "servers_used": self.servers_used,
            "features":     self.features,
            "is_grace":     self.is_grace,
            "grace_days":   GRACE_DAYS if self.is_grace else None,
            "can_add_server": self.block_reason() is None,
            "block_reason": self.block_reason(),
        }


# ── Codificação ────────────────────────────────────────────────────────────

def b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def b64url_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def canonical_payload(payload: dict) -> str:
    """JSON canônico → base64url. Mesma função usada na emissão e na leitura."""
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return b64url_encode(raw)


# ── Verificação ────────────────────────────────────────────────────────────

def _parse_iso(value: str) -> datetime:
    dt = datetime.fromisoformat(value)
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def verify_token(token: str) -> LicenseStatus:
    """
    Confere assinatura e prazo de um token. Não toca no banco — o
    `servers_used` e a cortesia de instalação são preenchidos por
    `license_status()`.
    """
    token = (token or "").strip()
    if not token:
        return LicenseStatus(
            state=STATE_MISSING,
            detail="Nenhuma licença configurada (MAILIQ_LICENSE vazia).",
            max_servers=GRACE_MAX_SERVERS,
        )

    invalid = lambda why: LicenseStatus(  # noqa: E731
        state=STATE_INVALID, detail=f"Licença inválida: {why}"
    )

    if _PUBLIC_KEY_B64 == "REPLACE_ME":
        return invalid(
            "esta build não tem chave pública de licenciamento embutida."
        )

    if token.count(".") != 1:
        return invalid("formato inesperado (esperado <payload>.<assinatura>).")
    payload_b64, sig_b64 = token.split(".", 1)

    try:
        public_key = ed25519.Ed25519PublicKey.from_public_bytes(
            base64.b64decode(_PUBLIC_KEY_B64)
        )
        public_key.verify(b64url_decode(sig_b64), payload_b64.encode("ascii"))
    except InvalidSignature:
        return invalid("a assinatura não confere com a chave de emissão.")
    except Exception as exc:  # base64 corrompido, chave malformada
        return invalid(f"não foi possível ler o token ({exc.__class__.__name__}).")

    try:
        payload = json.loads(b64url_decode(payload_b64))
        customer = str(payload["customer"])
        license_id = str(payload["license_id"])
        expires_at = _parse_iso(str(payload["expires_at"]))
        max_servers = int(payload["max_servers"])
        features = [str(f) for f in payload.get("features", [])]
    except Exception as exc:
        # Assinatura válida mas conteúdo que não sabemos ler: token emitido
        # por uma versão mais nova da ferramenta. Trata como inválido em vez
        # de adivinhar — e o detalhe diz o que fazer.
        return invalid(
            f"conteúdo não reconhecido ({exc.__class__.__name__}) — o token pode "
            "ter sido emitido para uma versão mais nova do painel."
        )

    now = datetime.now(timezone.utc)
    if expires_at <= now:
        state, detail = STATE_EXPIRED, f"Licença de {customer} venceu em {expires_at.date()}."
    elif expires_at - now <= timedelta(days=EXPIRING_WINDOW_DAYS):
        state, detail = STATE_EXPIRING, f"Licença de {customer} vence em {expires_at.date()}."
    else:
        state, detail = STATE_OK, f"Licença de {customer} válida até {expires_at.date()}."

    return LicenseStatus(
        state=state,
        detail=detail,
        customer=customer,
        license_id=license_id,
        expires_at=expires_at,
        max_servers=max_servers,
        features=features,
    )


def _installed_at(db) -> datetime:
    """
    Momento da instalação, âncora da cortesia. O admin do .env é semeado em
    todo boot, então o `created_at` mais antigo da tabela `users` é a data em
    que este painel subiu pela primeira vez — não precisa de tabela nova só
    para guardar isso. Sem usuários (banco recém-criado), a cortesia começa
    agora.
    """
    from .database import User

    try:
        oldest = db.query(User.created_at).order_by(User.created_at.asc()).first()
    except Exception:
        logger.exception("Falha ao ler a data de instalação; assumindo agora")
        return datetime.now(timezone.utc)
    if not oldest or not oldest[0]:
        return datetime.now(timezone.utc)
    dt = oldest[0]
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def license_status(db) -> LicenseStatus:
    """Estado completo: token + servidores em uso + cortesia de instalação."""
    from .config import settings
    from .database import Server

    status = verify_token(settings.mailiq_license)

    try:
        status.servers_used = db.query(Server).count()
    except Exception:
        logger.exception("Falha ao contar servidores para a licença")

    if status.state == STATE_MISSING:
        status.expires_at = _installed_at(db) + timedelta(days=GRACE_DAYS)
        status.max_servers = GRACE_MAX_SERVERS
        restante = status.days_left or 0
        status.detail = (
            f"Sem licença configurada — cortesia de instalação: "
            f"{GRACE_MAX_SERVERS} servidor, {restante} dia(s) restante(s)."
            if restante > 0 else
            f"Sem licença configurada e o período de cortesia de {GRACE_DAYS} "
            "dias terminou."
        )

    return status


def log_license_state(db) -> LicenseStatus:
    """Chamado no boot — deixa o estado da licença explícito no log."""
    status = license_status(db)
    if status.state in (STATE_OK,):
        logger.info("Licença: %s (%d servidor(es) de %d em uso)",
                    status.detail, status.servers_used, status.max_servers)
    else:
        logger.warning("Licença: %s (%d servidor(es) de %d em uso)",
                       status.detail, status.servers_used, status.max_servers)
    return status
