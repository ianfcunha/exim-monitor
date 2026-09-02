"""
CRUD de servidores EXIM.

GET    /api/servers              → lista servidores do usuário
POST   /api/servers              → adiciona servidor (admin only)
GET    /api/servers/{id}         → detalhe do servidor
PUT    /api/servers/{id}         → edita servidor (admin only)
DELETE /api/servers/{id}         → remove servidor (admin only)
POST   /api/servers/{id}/test    → testa conexão SSH (admin only)
POST   /api/servers/{id}/generate-key → gera par de chaves dedicado (admin only)
GET    /api/servers/{id}/ssh-status → status SSH atual do servidor
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..auth import get_current_user, require_admin
from ..crypto import SecretDecryptionError, encrypt_secret
from ..license import license_status
from ..database import (
    Server, User, build_server_cfg, get_db, get_server_owned_by,
    get_servers_for_user, to_utc_iso,
)
from ..limiter import limiter

router = APIRouter(prefix="/api/servers", tags=["servers"])

MASK = "••••••••"


# ── Schemas ────────────────────────────────────────────────────────────────

# T4 (Sessão 1, pós-auditoria): "root" deixa de ser o default — sem
# default nenhum aqui, o cliente do form tem que escolher. Root ainda é
# aceito (alguns pilotos vão chegar sem o bootstrap rodado), mas exige
# confirm_root=true explícito — ver create_server()/update_server().
class ServerCreate(BaseModel):
    name:          str = Field(..., min_length=1, max_length=100)
    host:          str = Field(..., min_length=1, max_length=255)
    port:          int = Field(22, ge=1, le=65535)
    ssh_user:      str = Field(..., min_length=1, max_length=100)
    ssh_auth_type: str = Field("key", pattern="^(password|key)$")
    ssh_secret:    str = Field("", description="Senha SSH ou conteúdo da chave privada — nunca preenchido automaticamente")
    script_path:   str = Field("/root/diag-exim.sh", max_length=500)
    confirm_root:  bool = Field(False, description="Obrigatório true se ssh_user='root' — ver docs/seguranca.md")


class ServerUpdate(BaseModel):
    name:          Optional[str] = Field(None, min_length=1, max_length=100)
    host:          Optional[str] = Field(None, min_length=1, max_length=255)
    port:          Optional[int] = Field(None, ge=1, le=65535)
    ssh_user:      Optional[str] = Field(None, max_length=100)
    ssh_auth_type: Optional[str] = Field(None, pattern="^(password|key)$")
    ssh_secret:    Optional[str] = Field(None, description="Novo segredo — deixe vazio para manter o atual")
    script_path:   Optional[str] = Field(None, max_length=500)
    is_enabled:    Optional[bool] = None
    # Sessão 4, T12: modo observação — o painel lê e diagnostica, mas
    # nenhuma ação que altera o servidor é executada.
    observation_mode: Optional[bool] = None
    reset_host_key: Optional[bool] = Field(
        None, description="true = esquece o fingerprint pinado; próxima conexão fixa um novo"
    )
    confirm_root:  bool = Field(False, description="Obrigatório true se ssh_user for alterado para 'root'")


def _to_response(s: Server, include_secret: bool = False) -> dict:
    return {
        "id":               s.id,
        "name":             s.name,
        "host":             s.host,
        "port":             s.port,
        "ssh_user":         s.ssh_user,
        "ssh_auth_type":    s.ssh_auth_type,
        "ssh_secret":       MASK if s.ssh_secret else "",  # nunca expõe o segredo real
        "script_path":      s.script_path,
        "ssh_host_key_fingerprint": s.ssh_host_key_fingerprint,
        "is_enabled":       s.is_enabled,
        "ssh_status":       s.ssh_status,
        "ssh_error_msg":    s.ssh_error_msg,
        # T4: aviso persistente no painel enquanto o servidor estiver
        # configurado como root — não é um erro (alguns pilotos vão
        # começar assim), mas precisa ficar visível o tempo todo, não só
        # no momento do cadastro.
        "is_root":          s.ssh_user == "root",
        "capabilities":     s.capabilities,
        # T12: o modo precisa viajar com o servidor para a interface
        # poder desabilitar as ações COM O MOTIVO, em vez de deixar o
        # clique falhar depois.
        "observation_mode": s.observation_mode,
        "last_connected_at": to_utc_iso(s.last_connected_at),
        "created_at":       to_utc_iso(s.created_at),
    }



# ── Endpoints ──────────────────────────────────────────────────────────────

@router.get("", summary="Listar servidores do usuário")
def list_servers(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    servers = get_servers_for_user(db, current_user)
    return [_to_response(s) for s in servers]


@router.post("", summary="Adicionar servidor (admin only)")
def create_server(
    payload: ServerCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    from ..ssh import SSHError, deploy_script

    # Licença: o ÚNICO ponto do painel que ela bloqueia. Servidor já
    # cadastrado nunca para de ser coletado por causa de licença — ver a
    # política em app/license.py.
    lic = license_status(db)
    reason = lic.block_reason()
    if reason:
        raise HTTPException(status_code=403, detail=reason)

    # T4: root exige escolha explícita — nunca é o default nem um
    # acidente de deixar o campo em branco.
    if payload.ssh_user == "root" and not payload.confirm_root:
        raise HTTPException(
            status_code=422,
            detail=(
                "Conectar como root exige confirmação explícita "
                "(confirm_root=true). Recomendado: rode mailiq-bootstrap.sh "
                "no servidor e use o usuário mailiq — veja docs/seguranca.md."
            ),
        )

    encrypted = encrypt_secret(payload.ssh_secret) if payload.ssh_secret else ""
    server = Server(
        owner_id      = current_user.id,
        name          = payload.name,
        host          = payload.host,
        port          = payload.port,
        ssh_user      = payload.ssh_user,
        ssh_auth_type = payload.ssh_auth_type,
        ssh_secret    = encrypted,
        script_path   = payload.script_path,
        is_enabled    = True,
        ssh_status    = "unknown",
    )
    db.add(server)
    db.commit()
    db.refresh(server)

    # Envia diag-exim.sh pro servidor recém-cadastrado via SFTP — evita
    # depender de instalação manual. Não bloqueia o cadastro: o servidor
    # já foi salvo acima, isto é só um "melhor esforço" cujo resultado
    # a UI mostra pro admin decidir se precisa agir manualmente.
    script_deployed = False
    script_deploy_error = None
    try:
        deploy_script(build_server_cfg(server))
        script_deployed = True
    except SSHError as exc:
        script_deploy_error = str(exc)[:500]
    except SecretDecryptionError as exc:
        # Praticamente impossível logo após encrypt_secret() com a
        # mesma chave em memória, mas não custa não deixar isso virar
        # um 500 cru se acontecer.
        script_deploy_error = str(exc)[:500]

    response = _to_response(server)
    response["script_deployed"] = script_deployed
    response["script_deploy_error"] = script_deploy_error
    return response


@router.get("/{server_id}", summary="Detalhe do servidor")
def get_server(
    server_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    server = get_server_owned_by(db, server_id, current_user)
    if not server:
        raise HTTPException(404, "Servidor não encontrado.")
    return _to_response(server)


@router.put("/{server_id}", summary="Editar servidor (admin only)")
def update_server(
    server_id: int,
    payload: ServerUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    server = get_server_owned_by(db, server_id, current_user)
    if not server:
        raise HTTPException(404, "Servidor não encontrado.")

    if payload.ssh_user == "root" and not payload.confirm_root:
        raise HTTPException(
            status_code=422,
            detail=(
                "Alterar para root exige confirmação explícita "
                "(confirm_root=true). Recomendado: rode mailiq-bootstrap.sh "
                "no servidor e use o usuário mailiq — veja docs/seguranca.md."
            ),
        )

    if payload.name          is not None: server.name          = payload.name
    if payload.host          is not None: server.host          = payload.host
    if payload.port          is not None: server.port          = payload.port
    if payload.ssh_user      is not None: server.ssh_user      = payload.ssh_user
    if payload.ssh_auth_type is not None: server.ssh_auth_type = payload.ssh_auth_type
    if payload.script_path   is not None: server.script_path   = payload.script_path
    if payload.is_enabled    is not None: server.is_enabled    = payload.is_enabled
    if payload.observation_mode is not None: server.observation_mode = payload.observation_mode
    if payload.reset_host_key:
        server.ssh_host_key_fingerprint = None

    # Só atualiza o segredo se vier preenchido e diferente da máscara
    if payload.ssh_secret and payload.ssh_secret != MASK:
        server.ssh_secret = encrypt_secret(payload.ssh_secret)

    db.commit()
    db.refresh(server)
    return _to_response(server)


@router.delete("/{server_id}", summary="Remover servidor (admin only)")
def delete_server(
    server_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    server = get_server_owned_by(db, server_id, current_user)
    if not server:
        raise HTTPException(404, "Servidor não encontrado.")

    db.delete(server)
    db.commit()
    return {"ok": True}


@router.post("/{server_id}/test", summary="Testar conexão SSH (admin only)")
@limiter.limit("10/minute")
def test_server(
    request: Request,
    response: Response,
    server_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    from datetime import datetime
    from ..ssh import HostKeyMismatchError, SSHError, deploy_script, run_check, test_connection

    server = get_server_owned_by(db, server_id, current_user)
    if not server:
        raise HTTPException(404, "Servidor não encontrado.")

    # T6 (Sessão 1, pós-auditoria): build_server_cfg() pode levantar
    # SecretDecryptionError agora (decrypt_secret() não engole mais o
    # erro) — tratado ANTES do try de conexão, com um status próprio
    # ("credential_error"), pra o operador saber que o problema é a
    # chave de criptografia, não a rede (AUDITORIA.md item 1).
    try:
        cfg = build_server_cfg(server)
    except SecretDecryptionError as exc:
        server.ssh_status    = "credential_error"
        server.ssh_error_msg = str(exc)[:500]
        db.commit()
        return {"ok": False, "status": "credential_error", "error": str(exc)}

    try:
        result = test_connection(cfg)
        server.ssh_status       = "ok"
        server.ssh_error_msg    = None
        server.last_connected_at = datetime.utcnow()

        # Primeira conexão bem-sucedida: fixa o fingerprint observado.
        # Conexões seguintes já chegam aqui validadas (ssh.py rejeita
        # antes se o fingerprint mudou), então isto só "grava" uma vez.
        first_seen = server.ssh_host_key_fingerprint is None
        if first_seen and result["fingerprint"]:
            server.ssh_host_key_fingerprint = result["fingerprint"]

        # Handshake SSH ok não garante que o script existe/funciona no
        # servidor remoto — roda --check para validar os pré-requisitos
        # reais (binário exim, exiqgrep, mainlog, cPanel/CSF). Falha aqui
        # não derruba o teste de conexão: fica registrada separadamente,
        # para a UI distinguir "SSH ok, script ausente/desatualizado" de
        # um erro genérico de conexão.
        #
        # T7 (Sessão 1, pós-auditoria): gap real achado testando o fluxo
        # de bootstrap de ponta a ponta — o deploy por SFTP só acontecia
        # em POST /servers (create_server), e naquele momento a chave
        # ainda não tinha sido instalada no servidor (mailiq-bootstrap.sh
        # roda DEPOIS que o admin já cadastrou/gerou a chave). Resultado:
        # SSH conectava, mas o script nunca chegava lá, e "Testar conexão"
        # ficava preso em "script não encontrado" pra sempre. Se --check
        # falhar por script ausente, tenta reimplantar por SFTP uma vez
        # (melhor esforço, mesmo padrão do cadastro) e roda --check de novo.
        checks = None
        check_error = None
        try:
            check_data = run_check(cfg)
            checks = check_data.get("checks")
        except SSHError as exc:
            try:
                deploy_script(cfg)
                check_data = run_check(cfg)
                checks = check_data.get("checks")
            except SSHError as retry_exc:
                check_error = str(retry_exc)[:500]

        # T4 (Sessão 1, pós-auditoria): persiste a sondagem de capacidade
        # (checks cap_*) no servidor — o painel usa isso pra desabilitar
        # botão de ação com o motivo visível, sem esperar a ação falhar
        # de verdade pra descobrir que faltava permissão ("falha
        # silenciosa" que a Tarefa 4 pediu pra eliminar).
        if checks:
            server.capabilities = {
                c["check"]: c["ok"] for c in checks if c.get("check", "").startswith("cap_")
            }

        db.commit()
        return {
            "ok": True,
            "latency_ms": result["latency_ms"],
            "status": "ok",
            "host_key_fingerprint": server.ssh_host_key_fingerprint,
            "host_key_first_seen": first_seen,
            "checks": checks,
            "check_error": check_error,
            "capabilities": server.capabilities,
        }
    except HostKeyMismatchError as exc:
        server.ssh_status    = "error"
        server.ssh_error_msg = str(exc)[:500]
        db.commit()
        return {"ok": False, "status": "host_key_mismatch", "error": str(exc)}
    except SSHError as exc:
        server.ssh_status    = "error"
        server.ssh_error_msg = str(exc)[:500]
        db.commit()
        return {"ok": False, "status": "error", "error": str(exc)}


@router.post("/{server_id}/generate-key", summary="Gera um par de chaves SSH dedicado (admin only)")
def generate_key(
    server_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """
    Tarefa 7 (Sessão 1, pós-auditoria) — fluxo de bootstrap sem senha de
    root: o painel gera um par de chaves Ed25519 dedicado a este
    servidor, guarda a privada cifrada (mesmo lugar de sempre,
    ssh_secret) e devolve a pública em texto puro pra colar no
    comando `mailiq-bootstrap.sh --pubkey '...'` — rodado pelo cliente
    no servidor monitorado, nunca pelo painel.

    Sobrescreve qualquer ssh_secret já salvo para este servidor —
    intencional (gerar uma chave nova invalida a anterior), por isso é
    uma ação explícita do admin, não algo automático no cadastro.
    """
    from ..crypto import generate_ed25519_keypair

    server = get_server_owned_by(db, server_id, current_user)
    if not server:
        raise HTTPException(404, "Servidor não encontrado.")

    comment = f"mailiq@{server.name}".replace(" ", "-")
    private_pem, public_line = generate_ed25519_keypair(comment)

    server.ssh_secret    = encrypt_secret(private_pem)
    server.ssh_auth_type = "key"
    server.ssh_user      = "mailiq"
    db.commit()

    return {
        "public_key": public_line,
        "bootstrap_command": f"bash mailiq-bootstrap.sh --pubkey '{public_line}'",
        "instructions": (
            "1. Copie mailiq-bootstrap.sh para o servidor EXIM (ele já está na raiz "
            "deste repositório, no mesmo lugar de onde você rodou o install.sh).\n"
            "2. No servidor EXIM, como root (uma única vez, localmente — nunca entregue "
            "essa senha ao painel): rode o comando 'bootstrap_command' acima.\n"
            "3. Leia o script inteiro antes de rodar — ele cria o usuário mailiq, "
            "instala esta chave pública, escreve /etc/sudoers.d/mailiq (allowlist "
            "documentada em docs/seguranca.md) e imprime uma sondagem do que a conexão "
            "consegue fazer.\n"
            "4. Volte aqui e clique em \"Testar conexão\"."
        ),
    }


@router.get("/{server_id}/ssh-status", summary="Status SSH atual do servidor")
def ssh_status(
    server_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    server = get_server_owned_by(db, server_id, current_user)
    if not server:
        raise HTTPException(404, "Servidor não encontrado.")
    return {
        "server_id":        server.id,
        "ssh_status":       server.ssh_status,
        "ssh_error_msg":    server.ssh_error_msg,
        "last_connected_at": to_utc_iso(server.last_connected_at),
    }
