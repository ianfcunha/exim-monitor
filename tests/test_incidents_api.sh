#!/usr/bin/env bash
# ============================================================
# Teste de aceite — Sessão 2, Tarefa 5 (API de incidentes).
#
# Roda contra o backend real (HTTP, login com as credenciais reais de
# backend/.env — mesmo padrão das sessões anteriores, não bypassa auth
# via JWT manual). Cria um incidente sintético direto no banco (ação
# clean-frozen, sempre segura/reversível — não mexe em nada real desta
# vez porque frozen_count=0 no host de teste) para exercitar
# fix/plan → fix/apply sem depender de os 4 detectores terem disparado
# de verdade neste momento.
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

SERVER_ID=$(curl -s "$API/servers" "${AUTH[@]}" | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")

# ── incidente sintético + ciclo ack/silence/resolve ─────────
INC_ID=$($COMPOSE exec -T backend sh -c "PYTHONPATH=/app python3" <<PYEOF
from app.database import SessionLocal, Incident, record_incident_event
from datetime import datetime
db = SessionLocal()
inc = Incident(
    server_id=$SERVER_ID, type="queue_stuck", severity="critico", status="aberto",
    fingerprint="queue_stuck:$SERVER_ID:__test_api__", entity="frozen",
    first_seen=datetime.utcnow(), last_seen=datetime.utcnow(),
    metrics={"frozen_count": 0}, triggered_by={"rule": "test", "observed": 0, "threshold": 0},
    suggested_fix={"description": "teste API", "action": {"action": "clean-frozen", "param": None}},
)
db.add(inc); db.commit(); db.refresh(inc)
record_incident_event(db, inc, "opened", actor="system")
db.commit()
print(inc.id)
db.close()
PYEOF
)
INC_ID=$(echo "$INC_ID" | tail -1)

LIST=$(curl -s "$API/incidents?server_id=$SERVER_ID" "${AUTH[@]}")
echo "$LIST" | python3 -c "import sys,json;d=json.load(sys.stdin);exit(0 if any(i['id']==$INC_ID for i in d) else 1)" \
    && ok "GET /incidents lista o incidente recém-criado" || fail "incidente não apareceu em GET /incidents"

DETAIL=$(curl -s "$API/incidents/$INC_ID" "${AUTH[@]}")
echo "$DETAIL" | python3 -c "import sys,json;d=json.load(sys.stdin);exit(0 if d['status']=='aberto' else 1)" \
    && ok "GET /incidents/{id} retorna status aberto" || fail "status inicial errado"

curl -s -X POST "$API/incidents/$INC_ID/ack" "${AUTH[@]}" >/dev/null && ok "POST /ack aceito"

SILENCE=$(curl -s -X POST "$API/incidents/$INC_ID/silence" "${AUTH[@]}" -H "Content-Type: application/json" -d '{"minutes":15}')
echo "$SILENCE" | python3 -c "import sys,json;d=json.load(sys.stdin);exit(0 if d['silenced_until'] else 1)" \
    && ok "POST /silence grava silenced_until" || fail "silence não gravou silenced_until"

# ── fix/plan → fix/apply ────────────────────────────────────
PLAN=$(curl -s -X POST "$API/incidents/$INC_ID/fix/plan" "${AUTH[@]}")
PLAN_ID=$(echo "$PLAN" | python3 -c "import sys,json;print(json.load(sys.stdin)['plan_id'])" 2>/dev/null || echo "")
[ -n "$PLAN_ID" ] && ok "POST /fix/plan devolve plan_id (não altera nada)" || fail "fix/plan não devolveu plan_id"

APPLY=$(curl -s -X POST "$API/incidents/$INC_ID/fix/apply" "${AUTH[@]}" -H "Content-Type: application/json" -d "{\"plan_id\":\"$PLAN_ID\"}")
echo "$APPLY" | python3 -c "import sys,json;d=json.load(sys.stdin);exit(0 if d.get('success') else 1)" \
    && ok "POST /fix/apply executa com sucesso" || fail "fix/apply falhou"

AFTER_APPLY=$(curl -s "$API/incidents/$INC_ID" "${AUTH[@]}")
echo "$AFTER_APPLY" | python3 -c "import sys,json;d=json.load(sys.stdin);exit(0 if d['status']=='mitigado' else 1)" \
    && ok "status vira 'mitigado' depois de fix/apply bem-sucedido" || fail "status não virou mitigado"

# apply sem plan novo (reusar o mesmo plan_id) deve falhar — plano de uso único
REUSE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/incidents/$INC_ID/fix/apply" "${AUTH[@]}" -H "Content-Type: application/json" -d "{\"plan_id\":\"$PLAN_ID\"}")
[ "$REUSE" = "409" ] && ok "reusar plan_id já consumido é rejeitado (409)" || fail "reuso de plan_id deveria ser 409, veio $REUSE"

# ── resolve manual ───────────────────────────────────────────
RESOLVE=$(curl -s -X POST "$API/incidents/$INC_ID/resolve" "${AUTH[@]}" -H "Content-Type: application/json" -d '{"resolution":"manual"}')
echo "$RESOLVE" | python3 -c "import sys,json;d=json.load(sys.stdin);exit(0 if d['status']=='resolvido' and d['resolution']=='manual' else 1)" \
    && ok "POST /resolve fecha o incidente com resolution=manual" || fail "resolve não fechou corretamente"

RESOLVE_AGAIN=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$API/incidents/$INC_ID/resolve" "${AUTH[@]}" -H "Content-Type: application/json" -d '{"resolution":"manual"}')
[ "$RESOLVE_AGAIN" = "409" ] && ok "resolver um incidente já resolvido é rejeitado (409)" || fail "resolver 2x deveria ser 409, veio $RESOLVE_AGAIN"

# ── config de thresholds ─────────────────────────────────────
CFG=$(curl -s -X PUT "$API/incidents/config/$SERVER_ID/auth_abuse" "${AUTH[@]}" -H "Content-Type: application/json" -d '{"thresholds":{"distinct_ips_threshold":7}}')
echo "$CFG" | python3 -c "import sys,json;d=json.load(sys.stdin);exit(0 if d['effective']['distinct_ips_threshold']==7 else 1)" \
    && ok "PUT /config sobrescreve threshold e reflete em 'effective'" || fail "override de threshold não aplicou"

BADCFG=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$API/incidents/config/$SERVER_ID/auth_abuse" "${AUTH[@]}" -H "Content-Type: application/json" -d '{"thresholds":{"chave_inventada":1}}')
[ "$BADCFG" = "422" ] && ok "chave de threshold desconhecida é rejeitada (422)" || fail "chave inválida deveria ser 422, veio $BADCFG"

# restaura threshold default e limpa o incidente sintético
curl -s -X PUT "$API/incidents/config/$SERVER_ID/auth_abuse" "${AUTH[@]}" -H "Content-Type: application/json" -d '{"thresholds":{}}' >/dev/null
$COMPOSE exec -T backend sh -c "PYTHONPATH=/app python3" <<PYEOF >/dev/null
from app.database import SessionLocal, Incident
db = SessionLocal()
db.query(Incident).filter(Incident.id == $INC_ID).delete()
db.commit()
db.close()
PYEOF

echo
echo "Resultado: $PASS ok, $FAIL falha(s)"
[ "$FAIL" -eq 0 ] || exit 1
