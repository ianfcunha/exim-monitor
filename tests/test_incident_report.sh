#!/usr/bin/env bash
# ============================================================
# Teste de aceite — Sessão 3, Tarefa 2 (relatório de incidente).
#
# Roda contra o backend real. Cria um incidente sintético com uma ação
# associada (incident_id) e confere que o relatório HTML: exige login
# (mesma auth de toda a API), traz as seções obrigatórias em português
# simples, não referencia nenhum recurso externo (CSS/JS/imagem — tem
# que abrir offline), e reflete a ação executada na seção "o que foi
# feito".
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

SETUP=$($COMPOSE exec -T backend sh -c "PYTHONPATH=/app python3" <<PYEOF
from app.database import SessionLocal, Incident, ActionHistory, record_incident_event
from datetime import datetime, timedelta
db = SessionLocal()
now = datetime.utcnow()
inc = Incident(
    server_id=$SERVER_ID, type="auth_abuse", severity="critico", status="aberto",
    fingerprint="auth_abuse:$SERVER_ID:__test_report__", entity="cliente@exemplo.com",
    first_seen=now - timedelta(hours=1), last_seen=now,
    metrics={"distinct_ips": 7, "auth_count": 300},
    triggered_by={"rule": "auth_abuse.distinct_ips", "observed": 7, "threshold": 3},
    suggested_fix={"description": "Conta cliente@exemplo.com autenticou de 7 IPs diferentes.",
                   "action": {"action": "clean-auth", "param": "cliente@exemplo.com"}},
    evidence={"lines": ["2026-08-22 10:00:00 auth:fail A=login:cliente@exemplo.com H=1.2.3.4"]},
)
db.add(inc); db.commit(); db.refresh(inc)
record_incident_event(db, inc, "opened", actor="system")
db.add(ActionHistory(server_id=$SERVER_ID, actor="admin", action="clean-auth", param="cliente@exemplo.com",
                      success=True, message="3 mensagens quarentenadas", incident_id=inc.id))
db.commit()
print(inc.id)
db.close()
PYEOF
)
INC_ID=$(echo "$SETUP" | tail -1)

# ── sem token, deve recusar (mesma proteção do resto da API) ──
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$API/incidents/$INC_ID/report")
[ "$CODE" = "401" ] && ok "sem token, /report recusa (401) — não é rota pública" || fail "esperava 401 sem token, veio $CODE"

REPORT=$(curl -s "$API/incidents/$INC_ID/report" "${AUTH[@]}")

echo "$REPORT" | grep -q "O que aconteceu"   && ok "seção 'O que aconteceu' presente"   || fail "faltou 'O que aconteceu'"
echo "$REPORT" | grep -q "O que causou"      && ok "seção 'O que causou' presente"      || fail "faltou 'O que causou'"
echo "$REPORT" | grep -q "O que foi feito"   && ok "seção 'O que foi feito' presente"   || fail "faltou 'O que foi feito'"
echo "$REPORT" | grep -q "sem intervenção"   && ok "seção do contrafactual presente"    || fail "faltou o contrafactual"
echo "$REPORT" | grep -q "Evidência técnica" && ok "seção de evidência presente"        || fail "faltou a evidência"
echo "$REPORT" | grep -q "auth:fail"         && ok "linha de evidência real aparece no relatório" || fail "evidência não apareceu"
echo "$REPORT" | grep -q "cliente@exemplo.com" && ok "conta afetada aparece no relatório" || fail "conta afetada não apareceu"
echo "$REPORT" | grep -qi "quarentenadas"    && ok "ação executada (ActionHistory) aparece em 'o que foi feito'" || fail "ação não apareceu"

if echo "$REPORT" | grep -qiE '<(script|link)[^>]*(src|href)="https?://|<img[^>]*src="https?://'; then
    fail "relatório referencia recurso externo — não é autocontido"
else
    ok "nenhuma referência a recurso externo (CSS/JS/imagem) — autocontido"
fi

echo
echo "Resultado: $PASS ok, $FAIL falha(s)"
[ "$FAIL" -eq 0 ]
