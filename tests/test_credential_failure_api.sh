#!/usr/bin/env bash
# ============================================================
# Teste de aceite — Tarefa 6 (Sessão 1, pós-auditoria), decrypt_secret().
#
# AUDITORIA.md item 1: decrypt_secret() engolia InvalidToken e devolvia
# "" — a conexão SSH seguinte falhava com um erro de rede genérico, sem
# nenhuma pista de que o problema real era a SSH_ENCRYPTION_KEY. Prova
# que POST /servers/{id}/test agora distingue esse caso
# (status="credential_error", nunca "error" genérico) corrompendo de
# propósito o ssh_secret de um servidor de teste via SQL direto.
#
# Roda contra a API + Postgres reais do dev stack. Cria e remove seu
# próprio servidor de teste.
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

if ! (cd "$SCRIPT_DIR" && docker compose exec -T postgres psql -U exim -d exim_monitor -c 'SELECT 1' >/dev/null 2>&1); then
    echo "Sem acesso ao Postgres via docker compose — pulando."
    exit 0
fi

AUTH_H="Authorization: Bearer $TOKEN"
NEW_ID=""
cleanup() { [ -n "$NEW_ID" ] && curl -s -X DELETE "$API_URL/api/servers/$NEW_ID" -H "$AUTH_H" >/dev/null 2>&1 || true; }
trap cleanup EXIT

CREATED=$(curl -s -X POST "$API_URL/api/servers" -H "$AUTH_H" -H "Content-Type: application/json" \
    -d '{"name":"mailiq-credtest","host":"127.0.0.1","ssh_user":"testuser","ssh_secret":"senha-valida-por-enquanto"}')
NEW_ID=$(echo "$CREATED" | jq -r '.id // empty')
if [ -z "$NEW_ID" ]; then
    fail "não consegui criar o servidor de teste: $CREATED"
    echo "── $PASS passou, $FAIL falhou ──"; exit 1
fi

# ── Corrompe o ssh_secret direto no banco — simula chave de
# criptografia trocada / backup restaurado sem o .env correspondente ──
(cd "$SCRIPT_DIR" && docker compose exec -T postgres psql -U exim -d exim_monitor -c \
    "UPDATE servers SET ssh_secret = 'gAAAAABlorem-ipsum-nao-e-fernet-valido==' WHERE id = $NEW_ID;" \
    >/dev/null 2>&1)

OUT=$(curl -s -X POST "$API_URL/api/servers/$NEW_ID/test" -H "$AUTH_H")
STATUS=$(echo "$OUT" | jq -r '.status // empty')
if [ "$STATUS" = "credential_error" ]; then
    ok "POST /test com segredo corrompido: status='credential_error' (distinto de erro de rede)"
else
    fail "POST /test: esperava status=credential_error, veio '$STATUS' ($OUT)"
fi

GET_OUT=$(curl -s "$API_URL/api/servers/$NEW_ID" -H "$AUTH_H")
SSH_STATUS=$(echo "$GET_OUT" | jq -r '.ssh_status // empty')
if [ "$SSH_STATUS" = "credential_error" ]; then
    ok "GET /servers/{id}: ssh_status persistido como 'credential_error'"
else
    fail "GET /servers/{id}: esperava ssh_status=credential_error, veio '$SSH_STATUS'"
fi

# ── O outro servidor cadastrado (se houver) continua respondendo —
# um segredo ilegível não pode derrubar os demais ──────────────────
OTHER_ID=$(curl -s "$API_URL/api/servers" -H "$AUTH_H" | jq -r --arg id "$NEW_ID" '[.[] | select((.id | tostring) != $id)][0].id // empty')
if [ -n "$OTHER_ID" ]; then
    OTHER_OUT=$(curl -s "$API_URL/api/servers/$OTHER_ID" -H "$AUTH_H")
    OTHER_STATUS=$(echo "$OTHER_OUT" | jq -r '.ssh_status // empty')
    if [ -n "$OTHER_STATUS" ] && [ "$OTHER_STATUS" != "credential_error" ]; then
        ok "outro servidor cadastrado (id=$OTHER_ID) não foi afetado pelo segredo corrompido"
    else
        fail "outro servidor (id=$OTHER_ID) aparenta ter sido afetado: ssh_status=$OTHER_STATUS"
    fi
else
    echo "  (nenhum outro servidor cadastrado pra checar — pulando essa checagem)"
fi

echo
echo "── $PASS passou, $FAIL falhou ──"
[ "$FAIL" -eq 0 ]
