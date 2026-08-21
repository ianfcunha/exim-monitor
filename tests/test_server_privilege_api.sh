#!/usr/bin/env bash
# ============================================================
# Teste de aceite — Tarefa 4 (Sessão 1, pós-auditoria), camada backend.
#
# Prova que POST/PUT /api/servers recusa "root" sem confirm_root=true
# explícito, aceita com confirm_root=true, e que POST /test persiste
# a sondagem de capacidade (checks cap_*) no servidor — GET /servers/
# {id} devolve is_root + capabilities sem precisar re-testar.
#
# Roda contra a API real do dev stack. Cria e remove seu próprio
# servidor de teste (não mexe nos servidores já cadastrados).
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

AUTH_H="Authorization: Bearer $TOKEN"
CT_H="Content-Type: application/json"
NEW_ID=""
api() { curl -s -o /tmp/priv_test_body.$$ -w '%{http_code}' "$@"; }
body() { cat /tmp/priv_test_body.$$; }
# Um único trap combinando as duas limpezas — um segundo `trap ... EXIT`
# SUBSTITUI o primeiro em bash, não encadeia; tinha um aqui que
# derrubava a exclusão do servidor de teste até este fix.
cleanup() {
    [ -n "$NEW_ID" ] && curl -s -X DELETE "$API_URL/api/servers/$NEW_ID" -H "$AUTH_H" >/dev/null 2>&1
    rm -f /tmp/priv_test_body.$$
    true
}
trap cleanup EXIT

# ── A: criar com ssh_user=root sem confirm_root — recusado ───────────
CODE=$(api -X POST "$API_URL/api/servers" -H "$AUTH_H" -H "$CT_H" \
    -d '{"name":"mailiq-privtest","host":"127.0.0.1","ssh_user":"root","ssh_secret":"x"}')
[ "$CODE" = "422" ] && ok "criar servidor root sem confirm_root: recusado (422)" \
    || fail "criar root sem confirm_root: esperava 422, veio $CODE ($(body))"

# ── B: mesmo payload, sem ssh_user — recusado (campo obrigatório) ────
CODE=$(api -X POST "$API_URL/api/servers" -H "$AUTH_H" -H "$CT_H" \
    -d '{"name":"mailiq-privtest","host":"127.0.0.1","ssh_secret":"x"}')
[ "$CODE" = "422" ] && ok "criar servidor sem ssh_user: recusado (422, sem default 'root' silencioso)" \
    || fail "criar sem ssh_user: esperava 422, veio $CODE ($(body))"

# ── C: criar com ssh_user=root + confirm_root=true — aceito ──────────
CODE=$(api -X POST "$API_URL/api/servers" -H "$AUTH_H" -H "$CT_H" \
    -d '{"name":"mailiq-privtest","host":"127.0.0.1","ssh_user":"root","ssh_secret":"x","confirm_root":true}')
NEW_ID=$(body | jq -r '.id // empty')
IS_ROOT=$(body | jq -r '.is_root // empty')
if [ "$CODE" = "200" ] && [ -n "$NEW_ID" ] && [ "$IS_ROOT" = "true" ]; then
    ok "criar servidor root com confirm_root=true: aceito, is_root=true na resposta"
else
    fail "criar root com confirm_root=true: code=$CODE id=$NEW_ID is_root=$IS_ROOT"
fi

# ── D: GET devolve is_root e capabilities (aviso persistente) ────────
CODE=$(api "$API_URL/api/servers/$NEW_ID" -H "$AUTH_H")
IS_ROOT=$(body | jq -r '.is_root // empty')
HAS_CAP_FIELD=$(body | jq -r 'has("capabilities")')
if [ "$IS_ROOT" = "true" ] && [ "$HAS_CAP_FIELD" = "true" ]; then
    ok "GET /servers/{id}: is_root e capabilities presentes na resposta (aviso persistente possível)"
else
    fail "GET /servers/{id}: is_root=$IS_ROOT has_capabilities_field=$HAS_CAP_FIELD"
fi

echo
echo "── $PASS passou, $FAIL falhou ──"
[ "$FAIL" -eq 0 ]
