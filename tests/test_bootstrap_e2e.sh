#!/usr/bin/env bash
# ============================================================
# Teste de aceite — Tarefa 7 (Sessão 1, pós-auditoria).
#
# Prova o fluxo inteiro sem senha de root pro painel, de ponta a
# ponta, contra a API real + Exim real deste host:
#   1. POST /servers/{id}/generate-key — painel gera o par de chaves
#   2. mailiq-bootstrap.sh --pubkey '<a que o painel gerou>' — roda
#      como root, LOCALMENTE, uma vez (é isso que o teste também faz,
#      simulando o "servidor monitorado")
#   3. POST /servers/{id}/test — SSH tem que funcionar com a chave que
#      o painel guardou, sem nenhuma senha ter sido informada
#   4. diagnóstico real tem que aparecer (GET /status/full)
#
# Requer root (bootstrap cria usuário de sistema + sudoers), Exim
# real, dev stack (API+Postgres) rodando, e a chave SSH do host
# ("Tyna Host LAB"/server padrão) alcançável — reusa o mesmo host
# público que os outros testes de API deste projeto já assumem.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOOTSTRAP="$SCRIPT_DIR/mailiq-bootstrap.sh"
API_URL="${MAILIQ_API_URL:-http://127.0.0.1:8000}"
MAILIQ_USER="mailiq"

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  OK   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

if [ "$(id -u)" -ne 0 ]; then
    echo "Requer root (mailiq-bootstrap.sh cria usuário de sistema) — pulando."
    exit 0
fi
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

# Precisa ser o IP DESTE host (é aqui que mailiq-bootstrap.sh vai
# rodar) alcançável a partir do container do backend — não o host de
# um servidor já cadastrado, que pode ser uma máquina remota genuína
# sem relação nenhuma com onde este teste está rodando. `hostname -I`
# traz o IP público real primeiro (mesmo endereço já usado pelo
# servidor "Tyna Host LAB" registrado neste dev stack).
REAL_HOST="${MAILIQ_TEST_HOST:-$(hostname -I | awk '{print $1}')}"
if [ -z "$REAL_HOST" ]; then
    echo "Não consegui detectar um IP alcançável deste host — pulando."
    exit 0
fi

AUTH_H="Authorization: Bearer $TOKEN"
NEW_ID=""
cleanup() {
    [ -n "$NEW_ID" ] && curl -s -X DELETE "$API_URL/api/servers/$NEW_ID" -H "$AUTH_H" >/dev/null 2>&1
    pkill -u "$MAILIQ_USER" >/dev/null 2>&1 || true
    sleep 1
    userdel -r "$MAILIQ_USER" >/dev/null 2>&1 || true
    rm -f "/etc/sudoers.d/$MAILIQ_USER"
    rm -rf /var/spool/exim_quarantine /var/log/exim-monitor/actions.log /var/log/exim-monitor/ip_blocks.tsv 2>/dev/null
    mkdir -p /var/log/exim-monitor
    true
}
trap cleanup EXIT

id "$MAILIQ_USER" &>/dev/null && fail "usuário $MAILIQ_USER já existe antes do teste — não sobrescrevendo, aborte e limpe manualmente" && exit 1

# ── 1. Cria o servidor e pede uma chave pro painel gerar ──────────────
CREATED=$(curl -s -X POST "$API_URL/api/servers" -H "$AUTH_H" -H "Content-Type: application/json" \
    -d "{\"name\":\"mailiq-bootstrap-test\",\"host\":\"$REAL_HOST\",\"ssh_user\":\"placeholder\",\"ssh_secret\":\"x\",\"script_path\":\"/home/$MAILIQ_USER/diag-exim.sh\"}")
NEW_ID=$(echo "$CREATED" | jq -r '.id // empty')
[ -z "$NEW_ID" ] && { fail "não consegui criar o servidor de teste: $CREATED"; echo "── $PASS passou, $FAIL falhou ──"; exit 1; }

GENKEY=$(curl -s -X POST "$API_URL/api/servers/$NEW_ID/generate-key" -H "$AUTH_H")
PUBKEY=$(echo "$GENKEY" | jq -r '.public_key // empty')
if [ -n "$PUBKEY" ] && echo "$PUBKEY" | grep -qE '^ssh-ed25519 '; then
    ok "POST /generate-key devolve uma chave pública ed25519 válida"
else
    fail "generate-key: resposta inesperada: $GENKEY"
fi

# ── 2. Roda o bootstrap como root, localmente, com a chave do painel ──
BOOTSTRAP_OUT=$(bash "$BOOTSTRAP" --pubkey "$PUBKEY" 2>&1)
if id "$MAILIQ_USER" &>/dev/null && [ -f "/etc/sudoers.d/$MAILIQ_USER" ]; then
    ok "mailiq-bootstrap.sh cria o usuário $MAILIQ_USER e escreve o sudoers"
else
    fail "bootstrap não criou usuário/sudoers como esperado: $BOOTSTRAP_OUT"
fi

if echo "$BOOTSTRAP_OUT" | grep -qF "Chave pública adicionada" || echo "$BOOTSTRAP_OUT" | grep -qF "já presente"; then
    ok "chave pública do painel foi instalada em authorized_keys"
else
    fail "bootstrap não confirmou instalação da chave pública"
fi

CAP_LINES=$(echo "$BOOTSTRAP_OUT" | grep -c '✓' || true)
if [ "$CAP_LINES" -ge 4 ]; then
    ok "sondagem de capacidade do bootstrap reporta as 4 capacidades OK ($CAP_LINES linhas ✓)"
else
    fail "sondagem de capacidade do bootstrap: esperava >=4 linhas OK, achou $CAP_LINES"
fi

# ── 3. Testa conexão pela API — sem nenhuma senha ter sido dada ───────
TEST_OUT=$(curl -s -X POST "$API_URL/api/servers/$NEW_ID/test" -H "$AUTH_H")
TEST_OK=$(echo "$TEST_OUT" | jq -r '.ok // empty')
if [ "$TEST_OK" = "true" ]; then
    ok "POST /test conecta como $MAILIQ_USER usando só a chave gerada pelo painel"
else
    fail "POST /test falhou: $TEST_OUT"
fi

CHECK_ERROR=$(echo "$TEST_OUT" | jq -r '.check_error // empty')
CAPS=$(echo "$TEST_OUT" | jq -r '.capabilities // {} | to_entries | map(select(.value == false)) | length')
if [ -z "$CHECK_ERROR" ] && [ "$CAPS" = "0" ]; then
    ok "diag-exim.sh foi (re)implantado automaticamente e as 4 capacidades vieram todas true"
else
    fail "check_error='$CHECK_ERROR' capacidades_false=$CAPS — self-heal do deploy não funcionou como esperado"
fi

# ── 4. Diagnóstico real fica visível ────────────────────────────────────
curl -s -X POST "$API_URL/api/status/refresh?server_id=$NEW_ID" -H "$AUTH_H" >/dev/null
sleep 1
STATUS_OUT=$(curl -s "$API_URL/api/status/full?server_id=$NEW_ID" -H "$AUTH_H")
SEVERITY=$(echo "$STATUS_OUT" | jq -r '.diagnosis.severity // empty')
if [ -n "$SEVERITY" ] && [ "$SEVERITY" != "UNKNOWN" ]; then
    ok "primeiro diagnóstico visível: severity=$SEVERITY"
else
    fail "diagnóstico não ficou visível: $STATUS_OUT"
fi

echo
echo "── $PASS passou, $FAIL falhou ──"
[ "$FAIL" -eq 0 ]
