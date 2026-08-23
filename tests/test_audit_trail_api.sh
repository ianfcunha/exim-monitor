#!/usr/bin/env bash
# ============================================================
# Teste de aceite — Tarefa 8 (Sessão 1, pós-auditoria).
#
# Prova: "quem, quando, o plano, o resultado real e como reverter" —
# incluindo tentativas negadas — fica registrado, e dá pra exportar
# por período/servidor em CSV e JSON.
#
# Roda contra a API + Exim reais do dev stack. A checagem de "tentativa
# negada" chama _require_admin_logged() direto dentro do container
# (mesma técnica já usada neste projeto quando não há uma conta viewer
# de verdade disponível pra logar via UI) em vez de fabricar um bypass
# de autenticação.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_URL="${MAILIQ_API_URL:-http://127.0.0.1:8000}"

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
    # Estes testes removem mensagens de verdade e conferem a quarentena
    # — precisam de um servidor que SAIBA fazer isso. Pegar `.[0]` cegamente
    # fazia o teste falhar como se o produto estivesse quebrado quando o
    # primeiro servidor da frota não tem a capacidade.
    SERVER_ID=$(curl -s "$API_URL/api/servers" -H "Authorization: Bearer $TOKEN" \
        | jq -r 'map(select(.capabilities.cap_remove_messages and .capabilities.cap_quarantine)) | .[0].id // empty')
fi
[ -z "$SERVER_ID" ] && { echo "Nenhum servidor cadastrado — pulando."; exit 0; }

AUTH_H="Authorization: Bearer $TOKEN"

# ── A: plan+apply real — plan_id e revert_hint ficam gravados ────────
bash "$SCRIPT_DIR/exim-test.sh" -n 2 >/dev/null 2>&1
PLAN=$(curl -s -X POST "$API_URL/api/actions/clean-full/plan?server_id=$SERVER_ID" -H "$AUTH_H" -H "Content-Type: application/json" -d '{}')
PLAN_ID=$(echo "$PLAN" | jq -r '.plan_id // empty')
curl -s -X POST "$API_URL/api/actions/clean-full?server_id=$SERVER_ID" -H "$AUTH_H" -H "Content-Type: application/json" \
    -d "{\"plan_id\": \"$PLAN_ID\"}" >/dev/null

HIST=$(curl -s "$API_URL/api/actions/history?server_id=$SERVER_ID&limit=1" -H "$AUTH_H")
HIST_PLAN_ID=$(echo "$HIST" | jq -r '.[0].plan_id // empty')
HIST_REVERT=$(echo "$HIST" | jq -r '.[0].revert_hint // empty')
if [ "$HIST_PLAN_ID" = "$PLAN_ID" ] && [ "$HIST_REVERT" = "restore-quarantine:$PLAN_ID" ]; then
    ok "histórico grava plan_id e revert_hint (restore-quarantine:$PLAN_ID)"
else
    fail "histórico: plan_id=$HIST_PLAN_ID (esperado $PLAN_ID) revert_hint=$HIST_REVERT"
fi

# limpa a quarentena criada
curl -s -X POST "$API_URL/api/actions/quarantine/$PLAN_ID/restore?server_id=$SERVER_ID" -H "$AUTH_H" >/dev/null
bash "$SCRIPT_DIR/exim-test.sh" --clean >/dev/null 2>&1

# ── B: exportação CSV e JSON, por servidor ────────────────────────────
# csv.writer (Python) usa CRLF por padrão (RFC 4180) — tr -d '\r' antes
# de comparar, senão o \r sobra colado em "message" e a comparação falha.
CSV_OUT=$(curl -s "$API_URL/api/actions/history/export?server_id=$SERVER_ID&format=csv" -H "$AUTH_H" | tr -d '\r')
if echo "$CSV_OUT" | head -1 | grep -q '^id,executed_at,server_id,actor,action,param,success,plan_id,revert_hint,message$'; then
    ok "export CSV tem o cabeçalho esperado (plan_id/revert_hint incluídos)"
else
    fail "export CSV: cabeçalho inesperado: $(echo "$CSV_OUT" | head -1)"
fi

JSON_OUT=$(curl -s "$API_URL/api/actions/history/export?server_id=$SERVER_ID&format=json" -H "$AUTH_H")
if echo "$JSON_OUT" | jq -e 'type == "array" and length > 0 and (.[0] | has("plan_id") and has("revert_hint"))' >/dev/null 2>&1; then
    ok "export JSON é um array com plan_id/revert_hint em cada entrada"
else
    fail "export JSON: formato inesperado"
fi

# ── C: tentativa negada (não-admin) fica registrada, não some no 403 ──
if ! (cd "$SCRIPT_DIR" && docker compose exec -T backend true >/dev/null 2>&1); then
    echo "  (sem acesso ao container backend via docker compose — pulando checagem C)"
else
    BEFORE=$(cd "$SCRIPT_DIR" && docker compose exec -T backend sh -c \
        "PYTHONPATH=/app python3 -c \"from app.database import SessionLocal, ActionHistory; db=SessionLocal(); print(db.query(ActionHistory).count()); db.close()\"" 2>/dev/null | tr -d '\r')

    DENY_OUT=$(cd "$SCRIPT_DIR" && docker compose exec -T backend sh -c "PYTHONPATH=/app python3 -c \"
from app.database import SessionLocal, User, ActionHistory
from app.routers.actions import _require_admin_logged
from fastapi import HTTPException

db = SessionLocal()
fake_viewer = User(id=999999, username='mailiq-audit-test-viewer', role='viewer', email='x@x.com')
try:
    _require_admin_logged(db, fake_viewer, 'clean-full', $SERVER_ID)
    print('NO_EXCEPTION')
except HTTPException as e:
    print('DENIED', e.status_code)
row = db.query(ActionHistory).order_by(ActionHistory.id.desc()).first()
print('LOGGED', row.actor, row.success, row.message)
db.close()
\"" 2>/dev/null)

    if echo "$DENY_OUT" | grep -q "^DENIED 403" && echo "$DENY_OUT" | grep -q "mailiq-audit-test-viewer False"; then
        ok "tentativa negada (não-admin) recusada com 403 E registrada no histórico (success=false)"
    else
        fail "tentativa negada: saída inesperada: $DENY_OUT"
    fi

    # limpa a linha sintética de teste
    (cd "$SCRIPT_DIR" && docker compose exec -T backend sh -c \
        "PYTHONPATH=/app python3 -c \"from app.database import SessionLocal, ActionHistory; db=SessionLocal(); db.query(ActionHistory).filter(ActionHistory.actor=='mailiq-audit-test-viewer').delete(); db.commit(); db.close()\"" \
        >/dev/null 2>&1) || true
fi

echo
echo "── $PASS passou, $FAIL falhou ──"
[ "$FAIL" -eq 0 ]
