#!/usr/bin/env bash
# ============================================================
# Teste de aceite — Sessão 4, Tarefa 10 (alertas que escalam).
#
# Roda contra a API real, logado. Cobre os quatro pontos da tarefa:
#
#   1. CANAL GLOBAL COM OVERRIDE POR SERVIDOR. Repetir bot token e chat
#      ID em cada servidor não sobrevive a uma frota de doze. O canal
#      vive no registro global (server_id NULL) e o servidor só o
#      substitui quando quer. Segredo herdado nunca viaja pela API — só
#      a informação de que ele existe.
#
#   2. CANAL LIGADO SEM CONFIGURAÇÃO COMPLETA avisa o que falta e NÃO
#      conta como ativo. Ligar o interruptor não é o mesmo que alertar.
#
#   3. "ENVIAR MENSAGEM DE TESTE" REPORTA O RESULTADO REAL DA CHAMADA,
#      com o erro do Telegram quando houver — urlopen levanta HTTPError
#      com a mensagem genérica do status e o motivo fica no corpo, que
#      ninguém lia.
#
#   4. VOCABULÁRIO ÚNICO (CRÍTICO/ATENÇÃO) na interface — guarda
#      estática sobre o código do painel, no mesmo espírito de
#      tests/test_health_single_source.sh.
#
# Mais o bug pré-existente achado na leitura: check_and_alert() exigia
# cfg.smtp_password para disparar e-mail mesmo com o Resend configurado,
# então alerta por Resend nunca disparava sozinho.
# ============================================================
set -uo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

API="${API:-http://localhost:8000}"
USER="$(grep -oP '^ADMIN_USERNAME=\K.*' backend/.env)"
PASSWORD="$(grep -oP '^ADMIN_PASSWORD=\K.*' backend/.env)"

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  OK   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

TOKEN="$(curl -s -X POST "$API/api/auth/login" -d "username=$USER&password=$PASSWORD" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')"
[ -n "$TOKEN" ] || { echo "FALHA: não foi possível autenticar na API"; exit 1; }
AUTH=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')

SID="$(curl -s "${AUTH[@]}" "$API/api/servers" \
    | python3 -c 'import json,sys; rows=json.load(sys.stdin); print(rows[0]["id"] if rows else "")')"
[ -n "$SID" ] || { echo "FALHA: nenhum servidor cadastrado para testar"; exit 1; }

get()  { curl -s "${AUTH[@]}" "$API/api/settings/alerts${1:-}"; }
put()  { curl -s -X PUT "${AUTH[@]}" "$API/api/settings/alerts${1}" -d "${2}"; }
# Caminho separado por pontos, sem eval — aspas dentro de -c viravam
# SyntaxError e faziam a asserção falhar por motivo errado.
field() {
    FIELD_PATH="$1" python3 -c '
import json, os, sys
d = json.load(sys.stdin)
for part in os.environ["FIELD_PATH"].split("."):
    d = d[part]
print(json.dumps(d, ensure_ascii=False))
'
}

# Estado original dos dois registros, restaurado no fim.
ORIG_GLOBAL="$(get)"
ORIG_SERVER="$(get "?server_id=$SID")"

restore() {
    python3 - "$ORIG_GLOBAL" "$ORIG_SERVER" <<'PYEOF' > /tmp/alert_restore.json
import json, sys
g, s = json.loads(sys.argv[1]), json.loads(sys.argv[2])
# Campos mascarados voltam como "" (o PUT trata "" como "não alterar").
for d in (g, s):
    for k in ("resend_api_key", "smtp_password", "telegram_bot_token", "webhook_secret"):
        if d.get(k, "").startswith("•"):
            d[k] = ""
json.dump({"global": g, "server": s}, open("/tmp/alert_restore.json", "w"))
PYEOF
    put "" "$(python3 -c 'import json;print(json.dumps(json.load(open("/tmp/alert_restore.json"))["global"]))')" > /dev/null
    put "?server_id=$SID" "$(python3 -c 'import json;print(json.dumps(json.load(open("/tmp/alert_restore.json"))["server"]))')" > /dev/null
    # O PUT trata "" como "não alterar" (senão salvar o formulário com o
    # campo mascarado apagaria o segredo), então os tokens sintéticos
    # deste teste não saem pela API — saem daqui.
    docker compose exec -T postgres psql -U exim -d exim_monitor -q -c \
        "update alert_settings set telegram_bot_token='' where telegram_bot_token like '%_DE_TESTE' or telegram_bot_token like '999:%'" \
        > /dev/null 2>&1
}
trap restore EXIT

echo "── T10: canal de alerta global, override por servidor ─────────"

# Telegram configurado APENAS no registro da frota.
put "" '{"telegram_enabled":true,"telegram_bot_token":"123456:TOKEN_INVALIDO_DE_TESTE","telegram_chat_id":"-1009999999999"}' > /dev/null
put "?server_id=$SID" '{"telegram_override":false,"telegram_enabled":false,"telegram_chat_id":""}' > /dev/null

SRV="$(get "?server_id=$SID")"

echo "$SRV" | field channels.telegram.active | grep -q true \
    && ok "servidor sem override herda o canal da frota — conta como ativo" \
    || fail "o canal da frota não chegou ao servidor (channels.telegram.active falso)"

echo "$SRV" | field in_effect.telegram.chat_id | grep -q '\-1009999999999' \
    && ok "a tela mostra o chat que está EM VIGOR, sem abrir a config da frota" \
    || fail "in_effect.telegram.chat_id não trouxe o valor herdado"

echo "$SRV" | field in_effect.telegram.has_token | grep -q true \
    && ok "o servidor sabe que existe um bot token em vigor" \
    || fail "in_effect.telegram.has_token não indicou o token herdado"

# O campo próprio pode vir vazio ou mascarado; o que não pode em
# hipótese nenhuma é o VALOR do segredo da frota aparecer na resposta
# deste servidor — in_effect diz só se existe.
echo "$SRV" | grep -q "TOKEN_INVALIDO_DE_TESTE" \
    && fail "o bot token da frota vazou em texto claro na resposta do servidor" \
    || ok "o segredo herdado NÃO viaja na resposta — só 'tem'/'não tem'"

# Override ligado: o servidor passa a ter o próprio canal.
put "?server_id=$SID" '{"telegram_override":true,"telegram_enabled":true,"telegram_bot_token":"999:OUTRO_TOKEN","telegram_chat_id":"-1002222222222"}' > /dev/null
get "?server_id=$SID" | field in_effect.telegram.chat_id | grep -q '\-1002222222222' \
    && ok "com override, o canal do servidor ganha do da frota" \
    || fail "o override não substituiu o canal da frota"

get | field telegram_chat_id | grep -q '\-1009999999999' \
    && ok "o override de um servidor não altera o canal da frota" \
    || fail "gravar no servidor vazou para o registro global"

echo
echo "── T10: canal ligado sem configuração completa ────────────────"

put "?server_id=$SID" '{"telegram_override":true,"telegram_enabled":true,"telegram_chat_id":""}' > /dev/null
INCOMPLETE="$(get "?server_id=$SID" | field channels.telegram)"

echo "$INCOMPLETE" | grep -q '"enabled": true' \
    && ok "o canal continua marcado como ligado (o usuário ligou mesmo)" \
    || fail "o canal ligado não voltou como enabled"

echo "$INCOMPLETE" | grep -q '"active": false' \
    && ok "ligado e incompleto NÃO conta como canal ativo" \
    || fail "um canal sem configuração completa apareceu como ativo"

echo "$INCOMPLETE" | grep -q 'chat ID' \
    && ok "a resposta nomeia o que falta ('chat ID'), não só 'incompleto'" \
    || fail "o campo que falta não foi nomeado: $INCOMPLETE"

echo
echo "── T10: teste de canal reporta o resultado real ───────────────"

CODE="$(curl -s -o /tmp/tg_test.json -w '%{http_code}' -X POST "${AUTH[@]}" \
    "$API/api/settings/test/telegram?server_id=$SID")"
[ "$CODE" = "400" ] && grep -q "chat ID" /tmp/tg_test.json \
    && ok "canal incompleto: o teste recusa antes de chamar e diz o que falta" \
    || fail "canal incompleto devolveu HTTP $CODE: $(cat /tmp/tg_test.json)"

# Token sintaticamente válido mas inexistente: o Telegram responde 401
# com "Unauthorized" no CORPO — é esse texto que precisa chegar à tela.
put "?server_id=$SID" '{"telegram_override":true,"telegram_enabled":true,"telegram_bot_token":"123456:TOKEN_INVALIDO_DE_TESTE","telegram_chat_id":"-1009999999999"}' > /dev/null
CODE="$(curl -s -o /tmp/tg_test.json -w '%{http_code}' -X POST "${AUTH[@]}" \
    "$API/api/settings/test/telegram?server_id=$SID")"
[ "$CODE" = "502" ] \
    && ok "falha real de envio devolve 502, não um 'ok' otimista" \
    || fail "envio com token inválido devolveu HTTP $CODE"

grep -qi "unauthorized" /tmp/tg_test.json \
    && ok "o erro do próprio Telegram chega à tela ('Unauthorized')" \
    || fail "o motivo do Telegram não apareceu: $(cat /tmp/tg_test.json)"

grep -qi "HTTP Error 401" /tmp/tg_test.json \
    && fail "ainda mostra a mensagem genérica do urllib em vez do motivo" \
    || ok "a mensagem genérica do urllib não é mais o que se lê"

echo
echo "── T10: vocabulário único CRÍTICO/ATENÇÃO na interface ────────"

if grep -qE "SEVERITY_OPTIONS = \['HIGH', 'CRITICAL'\]" frontend/src/pages/Settings.jsx; then
    fail "a configuração de alertas ainda oferece HIGH/CRITICAL como rótulo"
else
    ok "a configuração de alertas não expõe mais HIGH/CRITICAL como rótulo"
fi

for f in frontend/src/components/StatusBadge.jsx frontend/src/pages/Settings.jsx; do
    grep -q "severityLabel" "$f" \
        && ok "$(basename "$f") usa o vocabulário único (severityLabel)" \
        || fail "$(basename "$f") ainda imprime a severidade crua"
done

python3 - <<'PYEOF' && ok "severity.js traduz as duas escalas (script e incidente) para CRÍTICO/ATENÇÃO" \
                   || fail "severity.js não cobre as duas escalas"
import re, sys
src = open("frontend/src/lib/severity.js").read()
needed = ["CRITICAL:", "DEGRADED:", "HIGH:", "MEDIUM:", "critico:", "atencao:"]
sys.exit(0 if all(k in src for k in needed) else 1)
PYEOF

echo
echo "── Bug pré-existente: alerta por Resend nunca disparava ───────"

python3 - <<'PYEOF' && ok "check_and_alert aceita Resend como credencial de e-mail" \
                   || fail "check_and_alert ainda exige smtp_password — Resend não dispara sozinho"
import re, sys
src = open("backend/app/alerts.py").read()
gate = re.search(r"if cfg\.email_enabled and cfg\.email_to and ([^\n:]+):", src)
sys.exit(0 if gate and "resend_api_key" in gate.group(1) else 1)
PYEOF

echo
echo "════════════════════════════════════════════════════════"
echo "  PASS: $PASS   FAIL: $FAIL"
echo "════════════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ]
