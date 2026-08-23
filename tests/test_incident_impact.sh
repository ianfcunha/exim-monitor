#!/usr/bin/env bash
# ============================================================
# Teste de aceite — Sessão 3, Tarefa 1 (impacto por incidente).
#
# Roda contra o backend real (HTTP, login com credenciais reais de
# backend/.env). Cria um servidor descartável (host 127.0.0.1, sem
# ssh_secret válido — build_server_cfg() falha a decriptação e o
# coletor de background pula ele sem nunca tentar SSH de verdade, então
# snapshots reais não contaminam a janela "antes"/"durante" que o teste
# controla) com snapshots e um incidente sintéticos, exercita
# compute_impact() com números conhecidos, e apaga tudo no final
# (cascade). Precisa estar is_enabled=True (default) — a API só mostra
# incidentes de servidores habilitados (get_servers_for_user()).
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="http://localhost:8000/api"
COMPOSE="docker compose -f $SCRIPT_DIR/docker-compose.yml"

PASS=0; FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  OK   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

ADMIN_USER=$(grep '^ADMIN_USERNAME=' "$SCRIPT_DIR/backend/.env" | cut -d= -f2)
ADMIN_PASS=$(grep '^ADMIN_PASSWORD=' "$SCRIPT_DIR/backend/.env" | cut -d= -f2)
TOKEN=$(curl -s -X POST "$API/auth/login" \
    -d "username=$ADMIN_USER&password=$ADMIN_PASS" \
    -H "Content-Type: application/x-www-form-urlencoded" | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
AUTH=(-H "Authorization: Bearer $TOKEN")
[ -n "$TOKEN" ] && ok "login com credenciais reais de backend/.env" || fail "login falhou"

cleanup() {
    [ -n "${TEST_SERVER_ID:-}" ] && $COMPOSE exec -T backend sh -c "PYTHONPATH=/app python3" <<PYEOF >/dev/null 2>&1 || true
from app.database import SessionLocal, Server
db = SessionLocal()
s = db.get(Server, $TEST_SERVER_ID)
if s: db.delete(s); db.commit()
db.close()
PYEOF
}
trap cleanup EXIT

# ── servidor descartável + snapshots sintéticos + incidente ──
# "antes" (janela de 24h antes do incidente) a 100% de entrega, "durante"
# a 50%. over_4h=3 num dos pontos "durante", pra exercitar stuck_over_4h.
SETUP=$($COMPOSE exec -T backend sh -c "PYTHONPATH=/app python3" <<PYEOF
from app.database import SessionLocal, Server, User, Incident, Snapshot, record_incident_event
from datetime import datetime, timedelta
db = SessionLocal()
now = datetime.utcnow()
owner_id = db.query(User).filter(User.username == "$ADMIN_USER").first().id

server = Server(owner_id=owner_id, name="__test_impact__", host="127.0.0.1",
                 ssh_user="mailiq", ssh_auth_type="key")  # ssh_secret="" -> credential_error, coletor pula sem tentar SSH
db.add(server); db.commit(); db.refresh(server)
sid = server.id

for h in (25, 20, 15, 10, 5):
    db.add(Snapshot(server_id=sid, timestamp=now - timedelta(hours=h), mode="full",
                     delivered=100, rejected=0, data={"queue": {"age": {"over_4h": 0}}}))
db.add(Snapshot(server_id=sid, timestamp=now - timedelta(hours=1, minutes=30), mode="full",
                 delivered=50, rejected=50, data={"queue": {"age": {"over_4h": 3}}}))
db.add(Snapshot(server_id=sid, timestamp=now - timedelta(minutes=30), mode="full",
                 delivered=50, rejected=50, data={"queue": {"age": {"over_4h": 1}}}))
db.commit()

inc = Incident(
    server_id=sid, type="queue_stuck", severity="critico", status="aberto",
    fingerprint=f"queue_stuck:{sid}:__test_impact__", entity="sender:cliente@exemplo.com",
    first_seen=now - timedelta(hours=2), last_seen=now,
    metrics={"queue_total": 42}, triggered_by={"rule": "test", "observed": 42, "threshold": 10},
    suggested_fix={"description": "teste impacto", "action": None},
)
db.add(inc); db.commit(); db.refresh(inc)
record_incident_event(db, inc, "opened", actor="system")
db.commit()
print(f"{sid} {inc.id}")
db.close()
PYEOF
)
read -r TEST_SERVER_ID INC_ID <<< "$(echo "$SETUP" | tail -1)"

DETAIL=$(curl -s "$API/incidents/$INC_ID" "${AUTH[@]}")

echo "$DETAIL" | python3 -c "import sys,json;d=json.load(sys.stdin);exit(0 if d['impact'] is not None else 1)" \
    && ok "incidente aberto já tem impact calculado ao vivo (não-nulo)" || fail "impact veio nulo pra incidente aberto"

# Sessão 4, T6: todo valor de impacto virou
# {"estimable": true, "value": X, "basis": "..."} ou
# {"estimable": false, "reason": "..."} — nunca um número solto que o
# frontend precise adivinhar se é confiável.
echo "$DETAIL" | python3 -c "import sys,json;d=json.load(sys.stdin);m=d['impact']['messages_affected'];exit(0 if m['estimable'] and m['value']==42 and m['basis'] else 1)" \
    && ok "messages_affected estimável, vem de metrics.queue_total (42), com a base explicitada" || fail "messages_affected errado"

echo "$DETAIL" | python3 -c "import sys,json;d=json.load(sys.stdin);s=d['impact']['stuck_over_4h'];exit(0 if s['estimable'] and s['value']==3 else 1)" \
    && ok "stuck_over_4h pega o pior valor da janela (3)" || fail "stuck_over_4h errado"

echo "$DETAIL" | python3 -c "import sys,json;d=json.load(sys.stdin);exit(0 if d['impact']['accounts_affected']==['cliente@exemplo.com'] else 1)" \
    && ok "accounts_affected extraído de entity=sender:X" || fail "accounts_affected errado"

echo "$DETAIL" | python3 -c "import sys,json;d=json.load(sys.stdin);r=d['impact']['delivery_rate_impact_pct'];exit(0 if r['estimable'] and abs(r['value']-50.0)<0.5 else 1)" \
    && ok "delivery_rate_impact_pct ~50pp (100% antes vs 50% durante), atribuível a este incidente" || fail "delivery_rate_impact_pct errado"

echo "$DETAIL" | python3 -c "import sys,json;d=json.load(sys.stdin);exit(0 if 'cost_estimate' not in d['impact'] else 1)" \
    && ok "sem custo configurado, cost_estimate ausente (nunca inventado)" || fail "cost_estimate apareceu sem configuração"

# ── configura custo (só no servidor descartável) e confere que a estimativa aparece, rotulada ──
curl -s -o /dev/null -X PUT "$API/settings/alerts?server_id=$TEST_SERVER_ID" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{
    "cost_per_sysadmin_hour_brl": 80, "cost_per_ticket_brl": 25
}'
DETAIL2=$(curl -s "$API/incidents/$INC_ID" "${AUTH[@]}")
echo "$DETAIL2" | python3 -c "import sys,json;d=json.load(sys.stdin);ce=d['impact'].get('cost_estimate');exit(0 if ce and ce['label']=='estimativa' and ce['total_brl']>0 else 1)" \
    && ok "com custo configurado, cost_estimate aparece rotulado 'estimativa'" || fail "cost_estimate não apareceu configurado"

# ── resolve e confere que o impact fica congelado (não recalcula mais) ──
curl -s -o /dev/null -X POST "$API/incidents/$INC_ID/resolve" "${AUTH[@]}" -H 'Content-Type: application/json' -d '{"resolution":"manual"}'
RESOLVED=$(curl -s "$API/incidents/$INC_ID" "${AUTH[@]}")
echo "$RESOLVED" | python3 -c "import sys,json;d=json.load(sys.stdin);exit(0 if d['status']=='resolvido' and d['impact'] is not None else 1)" \
    && ok "impact continua presente depois de resolver (congelado)" || fail "impact sumiu após resolver"

FROZEN_AT=$(echo "$RESOLVED" | python3 -c "import sys,json;print(json.load(sys.stdin)['impact']['computed_at'])")
sleep 1
RESOLVED2=$(curl -s "$API/incidents/$INC_ID" "${AUTH[@]}")
FROZEN_AT2=$(echo "$RESOLVED2" | python3 -c "import sys,json;print(json.load(sys.stdin)['impact']['computed_at'])")
[ "$FROZEN_AT" = "$FROZEN_AT2" ] && ok "computed_at não muda entre leituras (não recalcula após congelar)" || fail "impact foi recalculado após resolver"

# ══════════════════════════════════════════════════════════════════
# Sessão 4, Tarefa 6 — impacto honesto.
#
# O defeito: "IMPACTO NA ENTREGA +0.4 p.p." aparecia idêntico nos dois
# incidentes abertos, um deles com "mensagens afetadas: 0", e com sinal
# POSITIVO dentro de um card vermelho. Três coisas erradas ao mesmo
# tempo — métrica do servidor exibida como métrica do incidente, número
# onde não havia número, e melhora exibida como impacto negativo.
# ══════════════════════════════════════════════════════════════════
echo
echo "── Sessão 4, T6: impacto atribuível ou 'não estimável' ────────"

docker compose exec -T backend sh -c 'PYTHONPATH=/app python3 -' <<'PYEOF' > /tmp/t6_impact.json
import json
from datetime import datetime, timedelta
from app.database import Incident, Server, Snapshot, SessionLocal, User
from app.incident_impact import compute_impact

db = SessionLocal()
owner = db.query(User).filter(User.role == "admin").first()
server = Server(owner_id=owner.id, name="__test_t6_impact__", host="127.0.0.1", port=22,
                ssh_user="nobody", ssh_auth_type="key", ssh_secret="",
                script_path="/nonexistent", is_enabled=False)
db.add(server); db.commit(); db.refresh(server)
sid = server.id
out = {}
try:
    now = datetime.utcnow()
    start = now - timedelta(hours=2)

    # (a) Reputação: não tem lote de mensagens próprio, e a taxa de
    #     entrega do servidor não é atribuível a ela.
    rep = Incident(server_id=sid, type="reputation", subtype="blocklist", severity="critico",
                   status="aberto", fingerprint=f"reputation:blocklist:{sid}:ip:203.0.113.1",
                   entity="ip:203.0.113.1", first_seen=start, last_seen=now,
                   metrics={"blocklists_listed": ["zen.spamhaus.org"], "zones_checked": 4},
                   triggered_by={"rule": "reputation.blocklist", "observed": 1})
    db.add(rep); db.commit(); db.refresh(rep)
    out["reputation"] = compute_impact(db, rep)

    # (b) Entrega MELHOROU durante o incidente — nunca pode virar um
    #     "impacto" positivo num card vermelho.
    for i in range(4):  # antes: 50% de entrega
        db.add(Snapshot(server_id=sid, timestamp=start - timedelta(hours=6, minutes=i),
                        mode="full", severity="OK", problem="NORMAL",
                        delivered=50, rejected=50, data={}))
    for i in range(4):  # durante: 100% de entrega
        db.add(Snapshot(server_id=sid, timestamp=start + timedelta(minutes=i),
                        mode="full", severity="OK", problem="NORMAL",
                        delivered=100, rejected=0, data={}))
    db.commit()
    # Encerra o incidente de reputação inteiramente ANTES da janela do
    # próximo cenário — senão ele mesmo conta como incidente simultâneo
    # e o caso (b) acabaria medindo o caso (c).
    rep.first_seen = start - timedelta(hours=5)
    rep.status = "resolvido"; rep.resolved_at = start - timedelta(hours=4)
    db.commit()

    q = Incident(server_id=sid, type="queue_stuck", subtype="fila", severity="critico",
                 status="aberto", fingerprint=f"queue_stuck:fila:{sid}:geral", entity="geral",
                 first_seen=start, last_seen=now, metrics={"queue_total": 500},
                 triggered_by={"rule": "queue_stuck.consecutive_growth", "observed": 500})
    db.add(q); db.commit(); db.refresh(q)
    out["improved"] = compute_impact(db, q)

    # (c) Dois incidentes abertos ao mesmo tempo — a variação da taxa de
    #     entrega deixa de ser atribuível a qualquer um dos dois.
    other = Incident(server_id=sid, type="auth_abuse", subtype="conta", severity="critico",
                     status="aberto", fingerprint=f"auth_abuse:conta:{sid}:a@b.com",
                     entity="a@b.com", first_seen=start, last_seen=now,
                     metrics={"auth_count": 10},
                     triggered_by={"rule": "auth_abuse.distinct_ips", "observed": 5})
    db.add(other); db.commit()
    out["concurrent"] = compute_impact(db, q)

    print(json.dumps(out))
finally:
    db.query(Snapshot).filter(Snapshot.server_id == sid).delete(synchronize_session=False)
    db.query(Incident).filter(Incident.server_id == sid).delete(synchronize_session=False)
    db.query(Server).filter(Server.id == sid).delete(synchronize_session=False)
    db.commit(); db.close()
PYEOF

T6=$(grep -v '^time=' /tmp/t6_impact.json | tail -1)
rm -f /tmp/t6_impact.json

echo "$T6" | python3 -c "import sys,json;d=json.load(sys.stdin);m=d['reputation']['messages_affected'];exit(0 if not m['estimable'] and m['reason'] else 1)" \
    && ok "reputação: 'mensagens afetadas' é não estimável, com motivo — nunca um '0' enganoso" || fail "reputação ainda exibe um número de mensagens afetadas"

echo "$T6" | python3 -c "import sys,json;d=json.load(sys.stdin);r=d['reputation']['delivery_rate_impact_pct'];exit(0 if not r['estimable'] and r['reason'] else 1)" \
    && ok "reputação: impacto na entrega é não estimável, com o motivo em uma linha" || fail "reputação ainda exibe impacto na taxa de entrega"

echo "$T6" | python3 -c "import sys,json;d=json.load(sys.stdin);rep=d['reputation'].get('reputation');exit(0 if rep and rep['listed_minutes']['estimable'] and rep['zones_listed']['estimable'] else 1)" \
    && ok "reputação: card trocado por dados verificáveis (minutos listado, zonas)" || fail "reputação não trouxe os dados verificáveis que substituem o card"

echo "$T6" | python3 -c "import sys,json;d=json.load(sys.stdin);r=d['improved']['delivery_rate_impact_pct'];exit(0 if r['estimable'] and r['value']==0.0 else 1)" \
    && ok "entrega que MELHOROU vira 0.0 com a base explicada — nunca uma variação positiva como 'impacto'" || fail "variação positiva exibida como impacto de incidente crítico"

echo "$T6" | python3 -c "import sys,json;d=json.load(sys.stdin);r=d['concurrent']['delivery_rate_impact_pct'];exit(0 if not r['estimable'] and 'outro' in r['reason'] else 1)" \
    && ok "com dois incidentes simultâneos, a variação da entrega deixa de ser atribuível a um deles" || fail "impacto de servidor ainda atribuído a um incidente específico"

echo
echo "Resultado: $PASS ok, $FAIL falha(s)"
[ "$FAIL" -eq 0 ]
