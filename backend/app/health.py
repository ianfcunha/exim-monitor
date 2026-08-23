"""
Sessão 4, Tarefa 5 — uma fonte de verdade.

Antes desta sessão, no mesmo instante e para o mesmo servidor, a Triagem
dizia "Entrega degradada — 2 incidentes ativos" enquanto o painel
clássico exibia "DIAGNÓSTICO ● OK" em verde. Eram dois cálculos
independentes: a Triagem contava incidentes; o painel lia o campo
`severity` do último snapshot de coleta. Um usuário não tem como
escolher em qual acreditar — e a resposta certa era a pior das duas.

Agora o estado de saúde do servidor é derivado dos INCIDENTES ABERTOS,
aqui e em nenhum outro lugar. As duas telas consomem esta função; um
teste (tests/test_health_single_source.sh) garante que não divergem.

O estado inclui explicitamente o quarto valor (Tarefa 1): um servidor
cujas verificações não puderam ser feitas não é "ok" — é
"indeterminado", com o motivo de cada checagem que falhou.
"""
from datetime import datetime
from typing import Any, Dict, List, Optional

from .database import Incident, Server, get_latest_check_results
from .detectors import STATUS_DESCONHECIDO

OPEN_STATUSES = ("aberto", "em_observacao", "mitigado")

# Vocabulário único de severidade em toda a interface (Tarefa 10): a
# Triagem já usava CRÍTICO/ATENÇÃO; a configuração de alertas usava
# HIGH/CRITICAL. CRÍTICO/ATENÇÃO venceu — é o vocabulário que aparece na
# tela que o usuário abre primeiro, e é português.
STATE_CRITICO = "critico"
STATE_ATENCAO = "atencao"
STATE_INDETERMINADO = "indeterminado"
STATE_OK = "ok"

_STATE_LABELS = {
    STATE_CRITICO: "Entrega degradada",
    STATE_ATENCAO: "Sob observação",
    STATE_INDETERMINADO: "Não verificado",
    STATE_OK: "Entrega normal",
}

# Ordem de gravidade — usada para reduzir vários servidores a um estado
# de frota. "Indeterminado" fica ACIMA de "ok" de propósito: não saber
# nunca pode ser exibido como estar bem.
_SEVERITY_ORDER = [STATE_OK, STATE_INDETERMINADO, STATE_ATENCAO, STATE_CRITICO]


def _worst(states: List[str]) -> str:
    worst = STATE_OK
    for state in states:
        if _SEVERITY_ORDER.index(state) > _SEVERITY_ORDER.index(worst):
            worst = state
    return worst


def _plural(n: int, singular: str, plural: str) -> str:
    return f"{n} {singular if n == 1 else plural}"


def compute_server_health(db, server_id: int, server_name: Optional[str] = None) -> Dict[str, Any]:
    """
    Estado de um servidor, derivado dos incidentes abertos e das últimas
    checagens. Retorna sempre a lista de incidentes que causaram o
    estado — o painel clássico linka para eles em vez de exibir um selo
    sem explicação.
    """
    incidents = (
        db.query(Incident)
        .filter(Incident.server_id == server_id, Incident.status.in_(OPEN_STATUSES))
        .order_by(Incident.last_seen.desc())
        .all()
    )
    n_critico = sum(1 for i in incidents if i.severity == "critico")
    n_atencao = sum(1 for i in incidents if i.severity == "atencao")

    unknown_checks = [
        {"key": c.check_key, "label": c.label, "reason": c.reason,
         "observed_at": c.observed_at.isoformat() + "Z"}
        for c in get_latest_check_results(db, server_id)
        if c.status == STATUS_DESCONHECIDO
    ]

    if n_critico:
        state = STATE_CRITICO
        headline = f"Entrega degradada — {_plural(n_critico + n_atencao, 'incidente ativo', 'incidentes ativos')}"
    elif n_atencao:
        state = STATE_ATENCAO
        headline = f"Sob observação — {_plural(n_atencao, 'incidente de atenção', 'incidentes de atenção')}"
    elif unknown_checks:
        state = STATE_INDETERMINADO
        headline = f"Não foi possível verificar — {_plural(len(unknown_checks), 'checagem', 'checagens')} sem resposta"
    else:
        state = STATE_OK
        headline = "Entrega normal — nenhum incidente ativo"

    return {
        "server_id": server_id,
        "server_name": server_name,
        "state": state,
        "label": _STATE_LABELS[state],
        "headline": headline,
        "open_critico": n_critico,
        "open_atencao": n_atencao,
        "unknown_checks": unknown_checks,
        "incidents": [
            {"id": i.id, "display_id": i.display_id, "type": i.type, "subtype": i.subtype,
             "severity": i.severity, "status": i.status, "entity": i.entity}
            for i in incidents
        ],
        "computed_at": datetime.utcnow().isoformat() + "Z",
    }


def compute_fleet_health(db, servers: List[Server]) -> Dict[str, Any]:
    """Estado da frota — o cabeçalho da Triagem quando "Toda a frota"
    está selecionada. Reduz os estados individuais pelo pior, nunca por
    média: um servidor crítico não é diluído por nove saudáveis."""
    per_server = [compute_server_health(db, s.id, s.name) for s in servers]
    n_critico = sum(h["open_critico"] for h in per_server)
    n_atencao = sum(h["open_atencao"] for h in per_server)
    affected = sum(1 for h in per_server if h["incidents"])
    unverified = [h for h in per_server if h["state"] == STATE_INDETERMINADO]

    state = _worst([h["state"] for h in per_server]) if per_server else STATE_OK

    if len(per_server) == 1:
        # Escopo de um servidor só: a frase é a DELE, não uma versão de
        # frota do mesmo fato. É o que faz a Triagem filtrada por
        # servidor e o painel clássico daquele servidor dizerem
        # exatamente a mesma coisa (T5) em vez de duas variações.
        headline = per_server[0]["headline"]
    elif not per_server:
        headline = "Nenhum servidor cadastrado"
    elif state == STATE_CRITICO:
        headline = (f"Entrega degradada — {_plural(n_critico + n_atencao, 'incidente ativo', 'incidentes ativos')} "
                    f"em {_plural(affected, 'servidor', 'servidores')}")
    elif state == STATE_ATENCAO:
        headline = f"Sob observação — {_plural(n_atencao, 'incidente de atenção', 'incidentes de atenção')}"
    elif state == STATE_INDETERMINADO:
        headline = f"Não foi possível verificar {_plural(len(unverified), 'servidor', 'servidores')}"
    else:
        headline = "Entrega normal — nenhum incidente ativo"

    return {
        "state": state,
        "label": _STATE_LABELS[state],
        "headline": headline,
        "open_critico": n_critico,
        "open_atencao": n_atencao,
        "servers_affected": affected,
        "servers": per_server,
        "computed_at": datetime.utcnow().isoformat() + "Z",
    }
