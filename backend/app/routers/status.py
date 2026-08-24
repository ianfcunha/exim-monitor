"""
Endpoints de status do servidor EXIM.

GET  /api/status/quick?server_id=   →  dados leves (cache 30s)
GET  /api/status/full?server_id=    →  dados completos (cache 5min)
POST /api/status/refresh?server_id= →  força nova coleta completa
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..collector import _cache, _empty_cache_entry, _save_snapshot, get_full, get_quick
from ..crypto import decrypt_secret
from ..database import User, get_db, get_server_owned_by, get_servers_for_user
from ..health import compute_server_health
from ..limiter import limiter
from ..ssh import SSHError, run_full as ssh_run_full

router = APIRouter(prefix="/api/status", tags=["status"])


def _resolve_server_id(server_id: Optional[int], db: Session, current_user: User) -> Optional[int]:
    """
    Resolve o server_id efetivo:
    - Se fornecido: valida que o usuário tem acesso e retorna.
    - Se omitido e o usuário tem UM servidor: aquele servidor.
    - Se omitido e o usuário tem vários: 400 nomeando a ambiguidade.

    Sessão 5 — o fallback "primeiro servidor da lista" era a raiz de um
    defeito sério na aba Fila. Em `?server=all` o frontend não manda
    server_id; esta função escolhia `servers[0]` calada, a tela exibia o
    diagnóstico do Cloudez sem dizer de quem era, e o painel de ações
    (que resolve o servidor por conta própria, pelo contexto do
    frontend) desenhava os botões com as permissões de OUTRO servidor —
    ações destrutivas habilitadas sem alvo identificado.

    Escolher por conta própria entre dois servidores é sempre um palpite
    sobre a intenção de quem chamou. Com um servidor só não há palpite
    nenhum, e o fallback continua valendo: é o caso de quem nunca
    interagiu com o seletor.
    """
    if server_id is not None:
        server = get_server_owned_by(db, server_id, current_user)
        if not server:
            raise HTTPException(404, f"Servidor {server_id} não encontrado.")
        return server_id

    servers = get_servers_for_user(db, current_user)
    if len(servers) == 1:
        return servers[0].id
    if len(servers) > 1:
        raise HTTPException(
            400,
            "Estes dados são de um servidor específico e você tem "
            f"{len(servers)} cadastrados — escolha um no seletor. "
            f"Disponíveis: {', '.join(s.name for s in servers)}.",
        )

    return None  # sem servidores cadastrados ainda


def _get_server_cfg(server_id: int, db: Session, current_user: User) -> dict:
    """Retorna dict de configuração SSH para o servidor."""
    server = get_server_owned_by(db, server_id, current_user)
    if not server:
        raise HTTPException(404, f"Servidor {server_id} não encontrado.")
    return {
        "host":                 server.host,
        "port":                 server.port,
        "ssh_user":             server.ssh_user,
        "ssh_auth_type":        server.ssh_auth_type,
        "ssh_secret":           decrypt_secret(server.ssh_secret),
        "script_path":          server.script_path,
        "host_key_fingerprint": server.ssh_host_key_fingerprint,
    }


@router.get("/quick", summary="Status leve para polling de dashboard")
def status_quick(
    server_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    sid = _resolve_server_id(server_id, db, current_user)
    data = get_quick(sid)
    if data is None:
        raise HTTPException(503, "Dados ainda não disponíveis — aguarde o próximo ciclo de coleta.")
    return data


@router.get("/full", summary="Diagnóstico completo")
def status_full(
    server_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    sid = _resolve_server_id(server_id, db, current_user)
    data = get_full(sid)
    if data is None:
        raise HTTPException(503, "Dados ainda não disponíveis — aguarde o próximo ciclo de coleta.")
    return data


@router.post("/refresh", summary="Força nova coleta completa")
@limiter.limit("10/minute")
def refresh(
    request: Request,
    response: Response,
    server_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from datetime import datetime

    sid = _resolve_server_id(server_id, db, current_user)
    if sid is None:
        raise HTTPException(400, "Nenhum servidor configurado.")

    server_cfg = _get_server_cfg(sid, db, current_user)

    try:
        data = ssh_run_full(server_cfg)

        if sid not in _cache:
            _cache[sid] = _empty_cache_entry()
        _cache[sid]["full"]    = data
        _cache[sid]["full_ts"] = datetime.utcnow()
        _save_snapshot(data, "full", sid)

        return data
    except SSHError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@router.get("/health", summary="Estado de saúde do servidor — mesma fonte da Triagem (Sessão 4, T5)")
def status_health(
    server_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    Sessão 4, Tarefa 5 — uma fonte de verdade.

    O painel clássico exibia "DIAGNÓSTICO ● OK" em verde lendo o campo
    `severity` do último snapshot de coleta, enquanto a Triagem, no mesmo
    instante e para o mesmo servidor, dizia "Entrega degradada — 2
    incidentes ativos". Este endpoint devolve exatamente o mesmo objeto
    que GET /api/incidents/summary, porque ambos chamam health.py — o
    painel passa a exibir o selo da triagem e os incidentes que o
    causaram, em vez de um segundo cálculo próprio.
    """
    sid = _resolve_server_id(server_id, db, current_user)
    if sid is None:
        raise HTTPException(400, "Nenhum servidor configurado.")
    server = get_server_owned_by(db, sid, current_user)
    return compute_server_health(db, sid, server.name if server else None)
