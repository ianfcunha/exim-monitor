"""
Sessão 3, Tarefa 4 — reputação como vigilância contínua.

A checagem em si já roda sozinha a cada ciclo completo do coletor (todo
`full_interval`, 5 min por padrão — ver incident_engine.py::
run_incident_cycle(), chamado de collector.py em todo ciclo "full"), não
mais só quando alguém clica um botão — isso é da Sessão 2 (T5). O que
faltava era a ABA: estado atual e histórico de entrada/saída de cada
blocklist, com data.

Sem tabela nova: em vez de armazenar toda checagem periódica bruta
(cresce sem limite, precisaria de retenção própria), esta rota deriva
tudo do ciclo de vida dos incidentes `reputation` que o motor de
detecção já mantém (Incident.first_seen = entrou, Incident.resolved_at
= saiu) — a mesma fonte de verdade que a Triagem usa, só reorganizada
por "o que está em risco agora" em vez de "o que está em aberto agora".

Limitação conhecida (documentada, não escondida): cada servidor tem UM
IP de saída e UM domínio primário verificados (deliverability check do
diag-exim.sh) — não enumera múltiplos IPs/domínios por servidor. Cobre
o caso comum (uma instância Exim = um IP de saída), não hosting
multi-IP por servidor.
"""
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..auth import get_current_user
from ..database import Incident, User, get_db, get_servers_for_user, to_utc_iso

router = APIRouter(prefix="/api/reputation", tags=["reputation"])

OPEN_STATUSES = ("aberto", "em_observacao", "mitigado")


def _subtype(metrics: dict) -> str:
    if "blocklists_listed" in metrics:
        return "blocklist"
    if "missing" in metrics:
        return "spf_dkim_dmarc"
    if "cert_valid" in metrics or "days_remaining" in metrics:
        return "cert"
    return "outro"


@router.get("", summary="Reputação — estado atual e histórico, cross-fleet por padrão")
def get_reputation(
    server_id: Optional[int] = Query(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    servers = get_servers_for_user(db, current_user)
    if server_id is not None:
        servers = [s for s in servers if s.id == server_id]
        if not servers:
            raise HTTPException(404, f"Servidor {server_id} não encontrado.")

    out = []
    for server in servers:
        all_reputation = (
            db.query(Incident)
            .filter(Incident.server_id == server.id, Incident.type == "reputation")
            .order_by(Incident.first_seen.desc())
            .limit(50)
            .all()
        )

        checks = {"blocklist": None, "spf_dkim_dmarc": None, "cert": None}
        for inc in all_reputation:
            sub = _subtype(inc.metrics or {})
            if sub not in checks or checks[sub] is not None:
                continue  # já achou o mais recente desse subtipo (lista vem ordenada desc)
            if inc.status in OPEN_STATUSES:
                checks[sub] = {
                    "status": "risco", "incident_id": inc.id, "display_id": inc.display_id,
                    "since": to_utc_iso(inc.first_seen), "entity": inc.entity,
                    "description": (inc.suggested_fix or {}).get("description"),
                }
            else:
                checks[sub] = {"status": "ok", "since": to_utc_iso(inc.resolved_at), "entity": inc.entity}
        for sub, val in checks.items():
            if val is None:
                checks[sub] = {"status": "ok", "since": None, "entity": None}

        history = []
        for inc in all_reputation:
            sub = _subtype(inc.metrics or {})
            history.append({
                "type": sub, "entity": inc.entity, "event": "entrou",
                "at": to_utc_iso(inc.first_seen), "incident_id": inc.id, "display_id": inc.display_id,
            })
            if inc.resolved_at:
                history.append({
                    "type": sub, "entity": inc.entity, "event": "saiu",
                    "at": to_utc_iso(inc.resolved_at), "incident_id": inc.id, "display_id": inc.display_id,
                })
        history.sort(key=lambda h: h["at"] or "", reverse=True)

        out.append({
            "server_id": server.id, "server_name": server.name,
            "last_checked_at": to_utc_iso(server.last_connected_at),
            "checks": checks,
            "history": history[:30],
        })

    return out
