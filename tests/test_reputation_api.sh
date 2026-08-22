#!/usr/bin/env bash
# ============================================================
# Teste de aceite — Sessão 3, Tarefa 4 (reputação — vigilância contínua).
#
# Roda contra o backend real. Cria, num servidor descartável, um
# incidente reputation/blocklist já resolvido (entrada+saída) e um
# reputation/cert ainda aberto (em risco), e confere que GET
# /api/reputation reflete exatamente isso: estado atual por subtipo e
# histórico com as duas pontas (entrou/saiu) na ordem certa.
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

SETUP=$($COMPOSE exec -T backend sh -c "PYTHONPATH=/app python3" <<PYEOF
from app.database import SessionLocal, Server, User, Incident, record_incident_event
from datetime import datetime, timedelta
db = SessionLocal()
now = datetime.utcnow()
owner_id = db.query(User).filter(User.username == "$ADMIN_USER").first().id
server = Server(owner_id=owner_id, name="__test_reputation__", host="127.0.0.1", ssh_user="mailiq", ssh_auth_type="key")
db.add(server); db.commit(); db.refresh(server)
sid = server.id

bl = Incident(server_id=sid, type="reputation", severity="critico", status="resolvido",
              fingerprint=f"reputation:{sid}:ip:9.9.9.9", entity="ip:9.9.9.9",
              first_seen=now - timedelta(days=2), last_seen=now - timedelta(days=1),
              resolved_at=now - timedelta(days=1), resolution="automatica",
              metrics={"blocklists_listed": ["zen.spamhaus.org"], "ip": "9.9.9.9"},
              suggested_fix={"description": "teste", "action": None})
cert = Incident(server_id=sid, type="reputation", severity="critico", status="aberto",
                 fingerprint=f"reputation:{sid}:domain:teste.com", entity="domain:teste.com",
                 first_seen=now - timedelta(hours=3), last_seen=now,
                 metrics={"cert_valid": False, "days_remaining": -5},
                 suggested_fix={"description": "Certificado expirado.", "action": None})
db.add_all([bl, cert]); db.commit()
for i in (bl, cert):
    record_incident_event(db, i, "opened", actor="system")
db.commit()
print(sid)
db.close()
PYEOF
)
TEST_SERVER_ID=$(echo "$SETUP" | tail -1)

REP=$(curl -s "$API/reputation?server_id=$TEST_SERVER_ID" "${AUTH[@]}")

echo "$REP" | python3 -c "import sys,json;d=json.load(sys.stdin)[0];exit(0 if d['checks']['blocklist']['status']=='ok' else 1)" \
    && ok "blocklist já resolvida -> estado atual 'ok'" || fail "estado atual de blocklist errado"

echo "$REP" | python3 -c "import sys,json;d=json.load(sys.stdin)[0];exit(0 if d['checks']['cert']['status']=='risco' and d['checks']['cert']['entity']=='domain:teste.com' else 1)" \
    && ok "cert ainda aberto -> estado atual 'risco' com a entidade certa" || fail "estado atual de cert errado"

echo "$REP" | python3 -c "
import sys, json
d = json.load(sys.stdin)[0]
h = d['history']
bl_events = [e for e in h if e['type'] == 'blocklist']
assert len(bl_events) == 2, bl_events
assert bl_events[0]['event'] == 'saiu' and bl_events[1]['event'] == 'entrou', bl_events  # mais recente primeiro
assert bl_events[0]['entity'] == 'ip:9.9.9.9'
cert_events = [e for e in h if e['type'] == 'cert']
assert len(cert_events) == 1 and cert_events[0]['event'] == 'entrou', cert_events
" && ok "histórico tem entrada+saída da blocklist (ordem desc) e só a entrada do cert (ainda aberto)" \
    || fail "histórico não bateu com o esperado"

echo
echo "Resultado: $PASS ok, $FAIL falha(s)"
[ "$FAIL" -eq 0 ]
