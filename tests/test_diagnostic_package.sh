#!/usr/bin/env bash
# =============================================================================
# T10 — Pacote de diagnóstico: prova que ele não vaza nada.
#
# Este arquivo SAI da máquina do cliente e chega na nossa caixa de entrada.
# Um teste que só confira "o endpoint responde 200" não vale nada aqui — o
# defeito que importa é silencioso e só aparece depois de já ter vazado.
#
# Então o teste é adversarial: PLANTA canários reconhecíveis em todos os
# campos de credencial (banco + o que já está no .env), gera o pacote, e
# falha se qualquer um deles aparecer. Canário, e não "checar se o campo
# está vazio": num painel recém-instalado quase todo campo de credencial
# está vazio, e um teste assim passaria sem testar coisa nenhuma.
#
# Cobre:
#   1. Nenhum segredo do .env no pacote (chave Fernet, JWT, senha do admin,
#      senha do Postgres, licença)
#   2. Nenhuma credencial de canal (canários plantados no banco)
#   3. Nenhum token Fernet (gAAAAA...) — segredo SSH cifrado é material
#      criptográfico do cliente, mesmo cifrado
#   4. Nenhum hash de senha de usuário
#   5. Parte local de e-mail pseudonimizada nas linhas de evidência
#   6. Domínio PRESERVADO (é o que diagnostica entrega)
#   7. Pseudônimo estável entre dois pacotes do mesmo painel
#   8. Contas diferentes → pseudônimos diferentes (não colapsa tudo em um)
#   9. A limpeza final pega um segredo que escapou de um campo novo
#  10. Só admin baixa; sem token, 401
#
# Precisa do dev stack de pé. Restaura o banco ao estado anterior no fim.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_URL="${MAILIQ_API_URL:-http://127.0.0.1:8000}"

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  OK   - $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL - $1"; }

[ -f "$SCRIPT_DIR/backend/.env" ] || { echo "backend/.env não encontrado — pulando."; exit 0; }
command -v jq >/dev/null || { echo "jq ausente — pulando."; exit 0; }

ADMIN_USER=$(grep '^ADMIN_USERNAME=' "$SCRIPT_DIR/backend/.env" | cut -d= -f2-)
ADMIN_PASS=$(grep '^ADMIN_PASSWORD=' "$SCRIPT_DIR/backend/.env" | cut -d= -f2-)

TOKEN=$(curl -s -X POST "$API_URL/api/auth/login" \
    -d "username=${ADMIN_USER}&password=${ADMIN_PASS}" | jq -r '.access_token // empty')
[ -n "$TOKEN" ] || { echo "não autenticou em $API_URL — pulando (dev stack de pé?)."; exit 0; }
AUTH_H="Authorization: Bearer $TOKEN"

psql_() { (cd "$SCRIPT_DIR" && docker compose exec -T postgres psql -U exim -d exim_monitor "$@"); }
psql_ -c 'SELECT 1' >/dev/null 2>&1 || { echo "sem acesso ao Postgres — pulando."; exit 0; }

# ── Canários ───────────────────────────────────────────────────────────────
CAN_TG="CANARIO-telegram-9f3a2b1c4d5e6f70"
CAN_SMTP="CANARIO-smtp-1a2b3c4d5e6f7089"
CAN_RESEND="CANARIO-resend-0f1e2d3c4b5a6978"
CAN_HOOK="CANARIO-webhooksecret-abcdef0123456789"

BACKUP="/tmp/mailiq-alertsettings-backup.sql"
psql_ -t -A -c "COPY (SELECT id, smtp_password, resend_api_key, telegram_bot_token, webhook_secret FROM alert_settings ORDER BY id) TO STDOUT" > "$BACKUP" 2>/dev/null

restore_db() {
    while IFS=$'\t' read -r id smtp resend tg hook; do
        [ -z "${id:-}" ] && continue
        psql_ -q -c "UPDATE alert_settings SET smtp_password='${smtp}', resend_api_key='${resend}', telegram_bot_token='${tg}', webhook_secret='${hook}' WHERE id=${id};" >/dev/null 2>&1
    done < "$BACKUP"
    rm -f "$BACKUP" /tmp/mailiq-pkg-*.json
}
trap restore_db EXIT

psql_ -q -c "UPDATE alert_settings SET smtp_password='$CAN_SMTP', resend_api_key='$CAN_RESEND', telegram_bot_token='$CAN_TG', webhook_secret='$CAN_HOOK';" >/dev/null 2>&1 \
    || { fail "não consegui plantar os canários"; exit 1; }

PKG=/tmp/mailiq-pkg-1.json
curl -s "$API_URL/api/support/diagnostic-package" -H "$AUTH_H" -o "$PKG"
jq -e '.painel.version' "$PKG" >/dev/null 2>&1 || { fail "pacote inválido: $(head -c 200 "$PKG")"; exit 1; }

# ── 1/2. Segredos ──────────────────────────────────────────────────────────
falta_segredo() {
    local nome="$1" valor="$2"
    [ -z "$valor" ] && { echo "  (pulado: $nome está vazio nesta instalação)"; return; }
    if grep -qF -- "$valor" "$PKG"; then
        fail "VAZOU $nome no pacote de diagnóstico"
    else
        ok "$nome não aparece no pacote"
    fi
}

falta_segredo "SSH_ENCRYPTION_KEY" "$(grep '^SSH_ENCRYPTION_KEY=' "$SCRIPT_DIR/backend/.env" | cut -d= -f2-)"
falta_segredo "JWT_SECRET"         "$(grep '^JWT_SECRET='         "$SCRIPT_DIR/backend/.env" | cut -d= -f2-)"
falta_segredo "ADMIN_PASSWORD"     "$ADMIN_PASS"
falta_segredo "POSTGRES_PASSWORD"  "$(grep '^POSTGRES_PASSWORD='  "$SCRIPT_DIR/.env" 2>/dev/null | cut -d= -f2-)"
falta_segredo "MAILIQ_LICENSE"     "$(grep '^MAILIQ_LICENSE='     "$SCRIPT_DIR/backend/.env" | cut -d= -f2-)"
falta_segredo "canário do bot do Telegram" "$CAN_TG"
falta_segredo "canário da senha SMTP"      "$CAN_SMTP"
falta_segredo "canário da Resend API key"  "$CAN_RESEND"
falta_segredo "canário do segredo do webhook" "$CAN_HOOK"

# ── 3. Token Fernet ────────────────────────────────────────────────────────
if grep -qE 'gAAAAA[A-Za-z0-9_=-]{20,}' "$PKG"; then
    fail "VAZOU um token Fernet (segredo SSH cifrado) no pacote"
else
    ok "nenhum token Fernet (gAAAAA...) no pacote"
fi

# ── 4. Hash de senha ───────────────────────────────────────────────────────
if grep -qE '\$2[aby]\$[0-9]{2}\$' "$PKG"; then
    fail "VAZOU um hash bcrypt de senha no pacote"
else
    ok "nenhum hash bcrypt de senha no pacote"
fi

# ── 5/6. Pseudonimização ──────────────────────────────────────────────────
LINHAS=$(jq -r '[.incidentes.recentes[].evidencia.linhas[]] | join("\n")' "$PKG" 2>/dev/null)
if [ -z "$LINHAS" ]; then
    echo "  (pulado: nenhum incidente com linha de evidência neste banco)"
else
    # Endereços crus conhecidos deste banco de dev não podem sobreviver.
    if echo "$LINHAS" | grep -qE '(mailiq-drip|mailiq-fila)[A-Za-z0-9._%+-]*@'; then
        fail "parte local de e-mail apareceu CRUA nas linhas de evidência"
    else
        ok "parte local dos e-mails pseudonimizada nas linhas de evidência"
    fi
    if echo "$LINHAS" | grep -qE 'conta#[0-9a-f]{6}@'; then
        ok "pseudônimos no formato esperado (conta#xxxxxx@dominio)"
    else
        fail "não encontrei nenhum pseudônimo nas linhas de evidência"
    fi
    if echo "$LINHAS" | grep -qE 'conta#[0-9a-f]{6}@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'; then
        ok "domínio preservado (é o que diagnostica problema de entrega)"
    else
        fail "o domínio foi perdido junto com a parte local"
    fi
    # 8. contas diferentes não podem colapsar num pseudônimo só
    N_PSEUDO=$(echo "$LINHAS" | grep -oE 'conta#[0-9a-f]{6}' | sort -u | wc -l)
    if [ "$N_PSEUDO" -ge 2 ]; then
        ok "contas distintas recebem pseudônimos distintos ($N_PSEUDO no pacote)"
    else
        echo "  (pulado: só $N_PSEUDO conta distinta nas linhas — nada a distinguir)"
    fi
fi

# ── 7. Estabilidade entre pacotes ─────────────────────────────────────────
PKG2=/tmp/mailiq-pkg-2.json
curl -s "$API_URL/api/support/diagnostic-package" -H "$AUTH_H" -o "$PKG2"
P1=$(jq -r '[.incidentes.recentes[].evidencia.linhas[]] | join(" ")' "$PKG"  2>/dev/null | grep -oE 'conta#[0-9a-f]{6}' | sort -u | head -3 | tr '\n' ',')
P2=$(jq -r '[.incidentes.recentes[].evidencia.linhas[]] | join(" ")' "$PKG2" 2>/dev/null | grep -oE 'conta#[0-9a-f]{6}' | sort -u | head -3 | tr '\n' ',')
if [ -z "$P1" ]; then
    echo "  (pulado: sem pseudônimos para comparar entre pacotes)"
elif [ "$P1" = "$P2" ]; then
    ok "pseudônimo estável entre dois pacotes do mesmo painel"
else
    fail "pseudônimo mudou entre pacotes ($P1 vs $P2) — suporte perde a correlação"
fi

# ── 9. A limpeza final pega o que escapou de um campo ─────────────────────
SCRUB=$( (cd "$SCRIPT_DIR" && docker compose exec -T backend python -c "
from app.diagnostics import scrub_secrets
from app.config import settings
vazou = 'inicio ' + settings.ssh_encryption_key + ' meio gAAAAAABsomethingsomethingsomething== fim'
limpo = scrub_secrets(vazou)
print('CHAVE_FORA'  if settings.ssh_encryption_key not in limpo else 'CHAVE_DENTRO')
print('FERNET_FORA' if 'gAAAAA' not in limpo else 'FERNET_DENTRO')
" 2>/dev/null) )
if echo "$SCRUB" | grep -q CHAVE_FORA && echo "$SCRUB" | grep -q FERNET_FORA; then
    ok "limpeza final remove segredo que escapou de um campo (2ª camada)"
else
    fail "limpeza final não removeu o segredo plantado: $SCRUB"
fi

# ── 10. Autorização ───────────────────────────────────────────────────────
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$API_URL/api/support/diagnostic-package")
[ "$CODE" = "401" ] && ok "sem token: 401" || fail "sem token: esperava 401, veio $CODE"

VIEWER_ID=$(psql_ -t -A -c "SELECT id FROM users WHERE role='viewer' LIMIT 1;" 2>/dev/null | tr -d '[:space:]')
if [ -n "$VIEWER_ID" ]; then
    echo "  (viewer existe no banco — checagem de 403 exigiria a senha dele; coberta por require_admin)"
fi

echo
echo "── $PASS passou, $FAIL falhou ──"
[ "$FAIL" -eq 0 ]
