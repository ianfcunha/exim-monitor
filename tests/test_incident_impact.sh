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

echo "$DETAIL" | python3 -c "import sys,json;d=json.load(sys.stdin);exit(0 if d['impact']['messages_affected']==42 else 1)" \
    && ok "messages_affected vem de metrics.queue_total (42)" || fail "messages_affected errado"

echo "$DETAIL" | python3 -c "import sys,json;d=json.load(sys.stdin);exit(0 if d['impact']['stuck_over_4h']==3 else 1)" \
    && ok "stuck_over_4h pega o pior valor da janela (3)" || fail "stuck_over_4h errado"

echo "$DETAIL" | python3 -c "import sys,json;d=json.load(sys.stdin);exit(0 if d['impact']['accounts_affected']==['cliente@exemplo.com'] else 1)" \
    && ok "accounts_affected extraído de entity=sender:X" || fail "accounts_affected errado"

echo "$DETAIL" | python3 -c "import sys,json;d=json.load(sys.stdin);exit(0 if abs(d['impact']['delivery_rate_impact_pct']-50.0)<0.5 else 1)" \
    && ok "delivery_rate_impact_pct ~50pp (100% antes vs 50% durante)" || fail "delivery_rate_impact_pct errado"

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

echo
echo "Resultado: $PASS ok, $FAIL falha(s)"
[ "$FAIL" -eq 0 ]
