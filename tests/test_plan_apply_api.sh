#!/usr/bin/env bash
# ============================================================
# Teste de aceite — Tarefa 3 (Sessão 1, pós-auditoria), camada backend.
#
# tests/test_quarantine.sh já prova plan()/apply()/quarentena no nível
# do script. Este teste cobre a parte que só existe no backend: a
# guarda de plan_id em si — nunca aplicado sem plano, plano de uso
# único, plano expira depois de 5 minutos, plano não serve pra ação/
# servidor/parâmetro diferente do que foi planejado.
#
# Roda contra a API real deste dev stack (docker compose já de pé) e
# usa a mesma credencial admin do backend/.env. server_id vem de
# MAILIQ_TEST_SERVER_ID, ou do primeiro servidor cadastrado — precisa
# ser um servidor que este host consiga alcançar de verdade (mesma
# exigência do test_quarantine.sh: usa Exim real via exim-test.sh).
#
# Requer: docker compose up (backend+postgres), curl, jq, psql via
# `docker compose exec postgres`.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_URL="${MAILIQ_API_URL:-http://127.0.0.1:8000}"
EXIM_TEST="$SCRIPT_DIR/exim-test.sh"

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  OK   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

if [ ! -f "$SCRIPT_DIR/backend/.env" ]; then
    echo "backend/.env não encontrado — pulando (precisa do dev stack rodando)."
    exit 0
fi
ADMIN_USER=$(grep '^ADMIN_USERNAME=' "$SCRIPT_DIR/backend/.env" | cut -d= -f2)
ADMIN_PASS=$(grep '^ADMIN_PASSWORD=' "$SCRIPT_DIR/backend/.env" | cut -d= -f2)

TOKEN=$(curl -s -X POST "$API_URL/api/auth/login" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "username=${ADMIN_USER}&password=${ADMIN_PASS}" | jq -r .access_token)

if [ -z "$TOKEN" ] || [ "$TOKEN" = "null" ]; then
    echo "Não foi possível autenticar em $API_URL — pulando (dev stack não está de pé?)."
    exit 0
fi

SERVER_ID="${MAILIQ_TEST_SERVER_ID:-}"
if [ -z "$SERVER_ID" ]; then
    SERVER_ID=$(curl -s "$API_URL/api/servers" -H "Authorization: Bearer $TOKEN" | jq -r '.[0].id // empty')
fi
if [ -z "$SERVER_ID" ]; then
    echo "Nenhum servidor cadastrado — pulando."
    exit 0
fi

api() { curl -s -o /tmp/plan_apply_test_body.$$ -w '%{http_code}' "$@"; }
body() { cat /tmp/plan_apply_test_body.$$; }
trap 'rm -f /tmp/plan_apply_test_body.$$' EXIT

AUTH_H="Authorization: Bearer $TOKEN"
CT_H="Content-Type: application/json"

# ── A: apply sem plan_id — nunca pode executar ───────────────────────
CODE=$(api -X POST "$API_URL/api/actions/clean-frozen?server_id=$SERVER_ID" -H "$AUTH_H" -H "$CT_H" -d '{}')
[ "$CODE" = "422" ] && ok "apply sem plan_id: rejeitado (422)" \
    || fail "apply sem plan_id: esperava 422, veio $CODE ($(body))"

# ── B: plan() não altera nada — gera plan_id ─────────────────────────
bash "$EXIM_TEST" -n 2 >/dev/null 2>&1
QUEUE_BEFORE=$(exim -bpc 2>/dev/null)
CODE=$(api -X POST "$API_URL/api/actions/clean-full/plan?server_id=$SERVER_ID" -H "$AUTH_H" -H "$CT_H" -d '{}')
PLAN_ID=$(body | jq -r '.plan_id // empty')
QUEUE_AFTER_PLAN=$(exim -bpc 2>/dev/null)
if [ "$CODE" = "200" ] && [ -n "$PLAN_ID" ] && [ "$QUEUE_BEFORE" = "$QUEUE_AFTER_PLAN" ]; then
    ok "plan(): gera plan_id e não altera a fila ($QUEUE_BEFORE mensagens antes e depois)"
else
    fail "plan(): code=$CODE plan_id=$PLAN_ID fila_antes=$QUEUE_BEFORE fila_depois=$QUEUE_AFTER_PLAN"
fi

# ── C: plano não serve pra AÇÃO diferente da planejada ────────────────
CODE=$(api -X POST "$API_URL/api/actions/clean-frozen?server_id=$SERVER_ID" -H "$AUTH_H" -H "$CT_H" \
    -d "{\"plan_id\": \"$PLAN_ID\"}")
[ "$CODE" = "409" ] && ok "plano de clean-full recusado ao aplicar como clean-frozen (409)" \
    || fail "plano cruzado: esperava 409, veio $CODE ($(body))"

# ── D: apply de verdade com o plan_id certo ──────────────────────────
CODE=$(api -X POST "$API_URL/api/actions/clean-full?server_id=$SERVER_ID" -H "$AUTH_H" -H "$CT_H" \
    -d "{\"plan_id\": \"$PLAN_ID\"}")
SUCCESS=$(body | jq -r '.success // empty')
INCIDENT=$(body | jq -r '.quarantine_incident // empty')
QUEUE_AFTER_APPLY=$(exim -bpc 2>/dev/null)
if [ "$CODE" = "200" ] && [ "$SUCCESS" = "true" ] && [ "$QUEUE_AFTER_APPLY" -eq 0 ] && [ "$INCIDENT" = "$PLAN_ID" ]; then
    ok "apply() com plan_id correto: remove de verdade e quarentena = plan_id"
else
    fail "apply(): code=$CODE success=$SUCCESS fila_depois=$QUEUE_AFTER_APPLY incident=$INCIDENT"
fi

# ── E: reaplicar o MESMO plan_id — uso único ──────────────────────────
CODE=$(api -X POST "$API_URL/api/actions/clean-full?server_id=$SERVER_ID" -H "$AUTH_H" -H "$CT_H" \
    -d "{\"plan_id\": \"$PLAN_ID\"}")
[ "$CODE" = "409" ] && ok "reaplicar o mesmo plan_id: recusado (409, já consumido)" \
    || fail "reaplicar plan_id: esperava 409, veio $CODE ($(body))"

# limpa as 2 mensagens de teste desta rodada (foram pra quarentena)
curl -s -X POST "$API_URL/api/actions/quarantine/$PLAN_ID/restore?server_id=$SERVER_ID" -H "$AUTH_H" >/dev/null 2>&1 || true
bash "$EXIM_TEST" --clean >/dev/null 2>&1 || true

# ── F: plan_id inexistente ────────────────────────────────────────────
CODE=$(api -X POST "$API_URL/api/actions/clean-frozen?server_id=$SERVER_ID" -H "$AUTH_H" -H "$CT_H" \
    -d '{"plan_id": "00000000000000000000000000000000"}')
[ "$CODE" = "404" ] && ok "plan_id inexistente: rejeitado (404)" \
    || fail "plan_id inexistente: esperava 404, veio $CODE ($(body))"

# ── G: plano expirado (>5 min) — mexe direto no created_at via SQL ────
CODE=$(api -X POST "$API_URL/api/actions/clean-frozen/plan?server_id=$SERVER_ID" -H "$AUTH_H" -H "$CT_H" -d '{}')
OLD_PLAN_ID=$(body | jq -r '.plan_id // empty')
if [ -n "$OLD_PLAN_ID" ]; then
    docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T postgres \
        psql -U exim -d exim_monitor -c \
        "UPDATE action_plans SET created_at = NOW() - INTERVAL '10 minutes' WHERE id = '$OLD_PLAN_ID'" \
        >/dev/null 2>&1
    CODE=$(api -X POST "$API_URL/api/actions/clean-frozen?server_id=$SERVER_ID" -H "$AUTH_H" -H "$CT_H" \
        -d "{\"plan_id\": \"$OLD_PLAN_ID\"}")
    [ "$CODE" = "409" ] && ok "plano com 10min de idade: recusado (409, passou dos 5min)" \
        || fail "plano expirado: esperava 409, veio $CODE ($(body))"
else
    fail "não consegui gerar plano pra testar expiração"
fi

echo
echo "── $PASS passou, $FAIL falhou ──"
[ "$FAIL" -eq 0 ]
