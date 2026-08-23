#!/usr/bin/env bash
# ============================================================
# Teste de aceite — Sessão 4, Tarefas 9 e 12.
#
# T12 (modo observação): o modo não aparecia em lugar nenhum da
# interface, e o painel exibia Bloquear IP / Limpar bounces / Remover
# frozen como botões comuns. A garantia não pode ser "o botão está
# escondido" — tem que ser o backend recusando. Este teste bate na API
# real, logado, e confere que:
#   - uma ação que altera o servidor é recusada nas DUAS fases
#     (planejar e executar), não só na segunda;
#   - a recusa fica registrada na auditoria (uma negativa sem rastro é
#     um buraco no histórico);
#   - uma checagem somente-leitura continua passando;
#   - o modo viaja no payload do servidor, para a interface poder
#     desabilitar o controle COM O MOTIVO.
#
# T9 (relatório com URL estável): rota real em vez de blob:, e link de
# leitura com validade para quem não tem conta.
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

ORIGINAL="$(curl -s "${AUTH[@]}" "$API/api/servers" \
    | python3 -c "import json,sys; print(str(next(s for s in json.load(sys.stdin) if s['id']==$SID)['observation_mode']).lower())")"

restore() {
    curl -s -o /dev/null -X PUT "$API/api/servers/$SID" "${AUTH[@]}" \
        -d "{\"observation_mode\": $ORIGINAL}"
}
trap restore EXIT

echo "── Sessão 4, T12: modo observação recusa no backend ───────────"

SINCE="$(date -u +%Y-%m-%dT%H:%M:%S)"
sleep 1

RESP="$(curl -s -X PUT "$API/api/servers/$SID" "${AUTH[@]}" -d '{"observation_mode": true}')"
echo "$RESP" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin)["observation_mode"] is True else 1)' \
    && ok "o modo é gravado e volta no payload do servidor" \
    || fail "o modo não voltou no payload do servidor (a interface não teria como desabilitar nada)"

CODE="$(curl -s -o /tmp/obs_plan.json -w '%{http_code}' \
    -X POST "$API/api/actions/clean-frozen/plan?server_id=$SID" "${AUTH[@]}" -d '{}')"
[ "$CODE" = "409" ] \
    && ok "planejar uma ação destrutiva é recusado (409), não só o executar" \
    || fail "planejar uma ação destrutiva devolveu HTTP $CODE (esperado 409)"

python3 -c "
import json,sys
d = json.load(open('/tmp/obs_plan.json'))
sys.exit(0 if 'observação' in d.get('detail','') and 'Configurações' in d.get('detail','') else 1)
" && ok "a recusa explica o motivo e onde desligar o modo" \
  || fail "a recusa não explica o motivo nem onde desligar"

CODE="$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "$API/api/actions/clean-frozen?server_id=$SID" "${AUTH[@]}" -d '{"plan_id":"qualquer"}')"
[ "$CODE" = "409" ] \
    && ok "executar direto (sem passar pelo plano) também é recusado" \
    || fail "executar direto devolveu HTTP $CODE (esperado 409)"

CODE="$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "$API/api/actions/check-deliverability?server_id=$SID" "${AUTH[@]}" -d '{}')"
[ "$CODE" = "200" ] \
    && ok "checagem somente-leitura continua funcionando em modo observação" \
    || fail "checagem somente-leitura foi bloqueada (HTTP $CODE) — o modo virou 'desligar o produto'"

DENIED="$(docker compose exec -T postgres psql -U exim -d exim_monitor -tAc \
    "select count(*) from action_history
      where server_id=$SID and success=false
        and executed_at >= '$SINCE'
        and message like '%modo observação%'" 2>/dev/null | tr -d '[:space:]')"
[ "${DENIED:-0}" -ge 2 ] \
    && ok "as $DENIED tentativas negadas ficaram registradas na auditoria" \
    || fail "as tentativas negadas não foram registradas (encontradas: ${DENIED:-0})"

restore
echo "$ORIGINAL" | grep -q true || {
    CODE="$(curl -s -o /dev/null -w '%{http_code}' \
        -X POST "$API/api/actions/clean-frozen/plan?server_id=$SID" "${AUTH[@]}" -d '{}')"
    [ "$CODE" != "409" ] \
        && ok "com o modo desligado, a ação volta a ser planejável (HTTP $CODE)" \
        || fail "a ação continuou recusada mesmo com o modo desligado"
}

echo
echo "── Sessão 4, T9: relatório com endereço estável ───────────────"

INC_ID="$(curl -s "${AUTH[@]}" "$API/api/incidents?limit=1" \
    | python3 -c 'import json,sys; rows=json.load(sys.stdin); print(rows[0]["id"] if rows else "")')"

if [ -z "$INC_ID" ]; then
    echo "  (sem incidentes neste ambiente — parte do T9 não pôde ser exercitada)"
else
    CODE="$(curl -s -o /tmp/obs_report.html -w '%{http_code}' "${AUTH[@]}" "$API/api/incidents/$INC_ID/report")"
    [ "$CODE" = "200" ] && grep -qi "<html" /tmp/obs_report.html \
        && ok "a rota do relatório devolve HTML autocontido" \
        || fail "a rota do relatório devolveu HTTP $CODE sem HTML"

    SHARE="$(curl -s -X POST "$API/api/incidents/$INC_ID/report/share" "${AUTH[@]}" -d '{"hours": 24}')"
    TOKEN_PATH="$(echo "$SHARE" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("path",""))')"
    [ -n "$TOKEN_PATH" ] \
        && ok "link de leitura gerado com validade ($TOKEN_PATH)" \
        || fail "não foi possível gerar o link de leitura"

    if [ -n "$TOKEN_PATH" ]; then
        # Sem cabeçalho de autenticação, de propósito: é o ponto do link.
        CODE="$(curl -s -o /tmp/obs_shared.html -w '%{http_code}' "$API$TOKEN_PATH")"
        [ "$CODE" = "200" ] && grep -qi "<html" /tmp/obs_shared.html \
            && ok "o link de leitura abre SEM login" \
            || fail "o link de leitura não abriu sem login (HTTP $CODE)"

        cmp -s /tmp/obs_report.html /tmp/obs_shared.html \
            && ok "o relatório do link é idêntico ao da rota com login (renderização única)" \
            || fail "o link de leitura serve um conteúdo diferente do relatório com login"
    fi

    CODE="$(curl -s -o /dev/null -w '%{http_code}' "$API/api/incidents/shared/token-que-nao-existe")"
    [ "$CODE" = "404" ] \
        && ok "token inexistente é recusado (404)" \
        || fail "token inexistente devolveu HTTP $CODE"

    CODE="$(curl -s -o /dev/null -w '%{http_code}' "$API/api/incidents/$INC_ID/report")"
    [ "$CODE" = "401" ] || [ "$CODE" = "403" ] \
        && ok "a rota normal do relatório continua exigindo login (HTTP $CODE)" \
        || fail "a rota normal do relatório respondeu sem login (HTTP $CODE)"
fi

rm -f /tmp/obs_plan.json /tmp/obs_report.html /tmp/obs_shared.html

echo
echo "════════════════════════════════════════════════════════"
echo "  PASS: $PASS   FAIL: $FAIL"
echo "════════════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ]
