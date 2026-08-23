#!/usr/bin/env bash
# ============================================================
# Teste de aceite — Sessão 4, Tarefa 3 (parar o flapping).
#
# Aceite literal da tarefa: "simular uma sequência de respostas
# alternadas e o sistema abrir no máximo um incidente, com no máximo
# três notificações no ciclo inteiro (abriu, agravou, resolveu)".
#
# A sequência simulada reproduz o histórico real do INC-59: a mesma
# blocklist alternando entre resposta positiva, consulta RECUSADA
# (127.255.255.x, que o código antigo lia como listagem) e resposta
# limpa, doze vezes seguidas. Antes, cada alternância era uma transição
# de estado — e, com Telegram ligado, uma mensagem.
#
# Isolamento: cria um Server descartável (sem ssh_secret válido, então o
# coletor de background falha rápido e nunca escreve dados reais em cima
# do cenário) em vez de reusar o server_id=8, que tem coleta contínua
# neste ambiente.
# ============================================================
set -uo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

docker compose exec -T backend sh -c 'PYTHONPATH=/app python3 -' <<'PYEOF'
import sys
from datetime import datetime

from app import incident_engine
from app.database import (
    CheckResult, Incident, IncidentEvent, Server, SessionLocal, User,
)

PASS, FAIL = 0, 0
def ok(msg):
    global PASS; PASS += 1; print(f"  OK   - {msg}")
def fail(msg):
    global FAIL; FAIL += 1; print(f"  FAIL - {msg}")

db = SessionLocal()

# ── Servidor descartável ────────────────────────────────────────────
owner = db.query(User).filter(User.role == "admin").first()
server = Server(
    owner_id=owner.id, name="__test_hysteresis__", host="127.0.0.1", port=22,
    ssh_user="nobody", ssh_auth_type="key", ssh_secret="", script_path="/nonexistent",
    is_enabled=False,
)
db.add(server); db.commit(); db.refresh(server)
SID = server.id

# ── Captura de notificações ─────────────────────────────────────────
sent = []
incident_engine.notify_incident_event = lambda inc, ev: sent.append((inc.display_id, ev))

IP = "203.0.113.99"

def deliverability(zone_status):
    """Um payload de check-deliverability com a zen respondendo o que
    for pedido. 'recusada' devolve exatamente a resposta que a Spamhaus
    manda quando barra o resolver."""
    if zone_status == "listado":
        zone = {"list": "zen.spamhaus.org", "status": "listado", "listed": True,
                "raw": "127.0.0.4", "resolver": "127.0.0.1", "reason": "listagem real"}
    elif zone_status == "recusada":
        zone = {"list": "zen.spamhaus.org", "status": "desconhecido", "listed": None,
                "raw": "127.255.255.254", "resolver": "8.8.8.8",
                "reason": "consulta recusada pela zona (resposta na faixa 127.255.255.0/24)"}
    else:
        zone = {"list": "zen.spamhaus.org", "status": "limpo", "listed": False,
                "raw": "", "resolver": "127.0.0.1", "reason": "NXDOMAIN"}
    return {
        "ip": IP, "domain": "", "blocklists": [zone],
        "blocklist_resolver": zone["resolver"], "blocklist_status": "ok",
        "spf": {"found": True}, "dkim": {"found": True}, "dmarc": {"found": True},
        "cert": {"status": "ok", "parsed": True, "expired": False, "days_remaining": 200,
                 "hostname": "mail.exemplo.com", "hostname_source": "smtp_banner", "issuer": "X"},
    }

DATA = {"auth_ip_diversity": [], "top_defer_domains": [], "top_sender_count": 0,
        "queue": {"total": 0, "frozen": 0}}

def cycle(zone_status):
    incident_engine.evaluate_incidents(db, SID, DATA, deliverability(zone_status), None)

def n_incidents():
    return db.query(Incident).filter(Incident.server_id == SID).count()

try:
    # ── Cenário 1: sequência alternada de 12 leituras ────────────────
    # Exatamente o padrão do histórico do INC-59.
    print("── Sequência alternada (listado / recusada / limpo × 4) ──")
    for i in range(4):
        cycle("listado"); cycle("recusada"); cycle("limpo")

    total = n_incidents()
    if total <= 1:
        ok(f"a sequência alternada de 12 leituras produziu {total} incidente(s) (máximo permitido: 1)")
    else:
        fail(f"a sequência alternada produziu {total} incidentes — o flapping voltou")

    if len(sent) <= 3:
        ok(f"{len(sent)} notificação(ões) no ciclo inteiro (máximo permitido: 3) — {sent}")
    else:
        fail(f"{len(sent)} notificações no ciclo inteiro (máximo 3): {sent}")

    # ── Cenário 2: listagem persistente ABRE ─────────────────────────
    print()
    print("── Listagem persistente (3 leituras positivas consecutivas) ──")
    sent.clear()
    for _ in range(3):
        cycle("listado")
    inc = db.query(Incident).filter(Incident.server_id == SID,
                                    Incident.status.in_(["aberto", "em_observacao"])).first()
    if inc is not None:
        ok(f"listagem confirmada em leituras consecutivas abre incidente ({inc.display_id})")
    else:
        fail("listagem confirmada NÃO abriu incidente — a histerese está travando o produto")

    if [e for _, e in sent if e == "opened"]:
        ok("a abertura gerou exatamente uma notificação")
    else:
        fail("a abertura não notificou")

    # ── Cenário 3: recusa não fecha um incidente aberto ──────────────
    print()
    print("── Consulta recusada não resolve um incidente aberto ──")
    before = inc.status
    for _ in range(6):
        cycle("recusada")
    db.refresh(inc)
    if inc.status != "resolvido":
        ok(f"6 consultas recusadas seguidas não resolveram o incidente (status: {inc.status})")
    else:
        fail("consultas recusadas resolveram o incidente — 'não sei' virou 'está tudo bem'")

    if inc.unverified_since is not None:
        ok("o incidente ficou marcado como não reverificável, com o instante registrado")
    else:
        fail("o incidente não registrou desde quando não pôde ser reverificado")

    # ── Cenário 4: 5 leituras limpas FECHAM ──────────────────────────
    print()
    print("── Cinco leituras limpas consecutivas resolvem ──")
    for i in range(5):
        cycle("limpo")
        db.refresh(inc)
        if i < 4 and inc.status == "resolvido":
            fail(f"resolveu com apenas {i + 1} leitura(s) limpa(s) — histerese de fechamento não aplicada")
            break
    db.refresh(inc)
    if inc.status == "resolvido":
        ok("resolvido após 5 leituras limpas consecutivas")
    else:
        fail(f"não resolveu após 5 leituras limpas (status: {inc.status})")

    # ── Cenário 5: cooldown impede reabertura imediata ───────────────
    print()
    print("── Cooldown: incidente resolvido não reabre sem mudança material ──")
    n_before = n_incidents()
    for _ in range(3):
        cycle("listado")
    n_after = n_incidents()
    if n_after == n_before:
        ok(f"nenhum incidente novo dentro da janela de cooldown ({incident_engine.COOLDOWN_MINUTES}min)")
    else:
        fail(f"reabriu {n_after - n_before} incidente(s) dentro do cooldown")

finally:
    db.query(IncidentEvent).filter(
        IncidentEvent.incident_id.in_(
            db.query(Incident.id).filter(Incident.server_id == SID)
        )
    ).delete(synchronize_session=False)
    db.query(Incident).filter(Incident.server_id == SID).delete(synchronize_session=False)
    db.query(CheckResult).filter(CheckResult.server_id == SID).delete(synchronize_session=False)
    db.query(Server).filter(Server.id == SID).delete(synchronize_session=False)
    db.commit()
    db.close()

print()
print("════════════════════════════════════════════════════════")
print(f"  PASS: {PASS}   FAIL: {FAIL}")
print("════════════════════════════════════════════════════════")
sys.exit(1 if FAIL else 0)
PYEOF
