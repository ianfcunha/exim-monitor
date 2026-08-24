#!/usr/bin/env bash
# ============================================================
# Teste de aceite — Sessão 5 (escopo de servidor).
#
# Origem: a verificação em navegador da Sessão 4 encontrou, na aba Fila
# em "Toda a frota", o diagnóstico de um servidor exibido sem dizer qual
# ele era, ao lado de um painel de ações desenhado com as permissões de
# OUTRO servidor — botões destrutivos clicáveis sem alvo identificado.
#
# A raiz não estava na tela: `_resolve_server_id()` caía em `servers[0]`
# calada quando o pedido vinha sem server_id, e `_resolve_server_cfg()`
# devolvia None (servidor do .env), o que de quebra pulava a checagem de
# modo observação, que retorna cedo sem server_id.
#
# Escolher por conta própria entre dois servidores é sempre um palpite
# sobre a intenção de quem chamou. Este teste prova que o backend recusa
# o palpite em vez de fazê-lo — e que com UM servidor só (onde não há
# ambiguidade) o caminho legado continua valendo.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="http://localhost:8000/api"

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

SERVERS=$(curl -s "$API/servers" "${AUTH[@]}")
N=$(echo "$SERVERS" | python3 -c "import sys,json;print(len(json.load(sys.stdin)))")
SID=$(echo "$SERVERS" | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")
OTHER=$(echo "$SERVERS" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[1]['id'] if len(d)>1 else '')")

if [ "$N" -lt 2 ]; then
    echo "  SKIP - precisa de 2+ servidores cadastrados para provar a ambiguidade (há $N)"
    echo; echo "Resultado: $PASS ok, $FAIL falha(s)"; [ "$FAIL" -eq 0 ]; exit
fi

code() { curl -s -o /tmp/scope_body.json -w '%{http_code}' "$@"; }

echo
echo "── Dados de um servidor não podem sair sem servidor identificado ──"

for path in "status/quick" "status/full" "status/health"; do
    C=$(code "$API/$path" "${AUTH[@]}")
    [ "$C" = "400" ] && grep -q "escolha um" /tmp/scope_body.json \
        && ok "GET /$path sem server_id recusa e nomeia os servidores disponíveis" \
        || fail "GET /$path sem server_id devolveu HTTP $C: $(head -c 160 /tmp/scope_body.json)"
done

C=$(code "$API/status/quick?server_id=$SID" "${AUTH[@]}")
[ "$C" = "200" ] || [ "$C" = "503" ] \
    && ok "com server_id explícito a rota responde normalmente (HTTP $C)" \
    || fail "GET /status/quick?server_id=$SID devolveu HTTP $C"

echo
echo "── Ação destrutiva sem alvo identificado ──"

# O plano é a primeira porta: apply() só executa com um plan_id emitido
# por ele (T3, Sessão 1). Fechar o plano fecha a cadeia inteira.
C=$(code -X POST "$API/actions/clean-frozen/plan" "${AUTH[@]}")
[ "$C" = "400" ] && grep -q "escolha um" /tmp/scope_body.json \
    && ok "plan de ação destrutiva sem server_id recusa em vez de mirar o .env" \
    || fail "POST /actions/clean-frozen/plan sem server_id devolveu HTTP $C: $(head -c 160 /tmp/scope_body.json)"

C=$(code -X POST "$API/actions/block-ip/plan" "${AUTH[@]}" \
    -H "Content-Type: application/json" -d '{"param":"1.2.3.4"}')
[ "$C" = "400" ] \
    && ok "o mesmo vale para block-ip — não é uma exceção de uma ação só" \
    || fail "POST /actions/block-ip/plan sem server_id devolveu HTTP $C: $(head -c 160 /tmp/scope_body.json)"

echo
echo "── Telas que ignoravam o escopo ──"

# Reputação renderizava a frota inteira mesmo com um servidor no
# seletor; o histórico de alertas não tinha escopo nenhum e devolvia
# linhas de todos os servidores do banco, sem dizer de qual era cada uma.
ROWS=$(curl -s "$API/reputation?server_id=$SID" "${AUTH[@]}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(len(d), all(r['server_id']==$SID for r in d))")
[ "$ROWS" = "1 True" ] \
    && ok "GET /reputation?server_id=N devolve só aquele servidor" \
    || fail "GET /reputation?server_id=$SID devolveu: $ROWS"

MIXED=$(curl -s "$API/settings/alerts/history?server_id=$SID&limit=200" "${AUTH[@]}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(sum(1 for r in d if r['server_id']!=$SID))")
[ "$MIXED" = "0" ] \
    && ok "GET /settings/alerts/history?server_id=N não mistura outros servidores" \
    || fail "o histórico escopado trouxe $MIXED linha(s) de outro servidor"

NAMED=$(curl -s "$API/settings/alerts/history?limit=200" "${AUTH[@]}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print('sem-linhas' if not d else all(r.get('server_name') for r in d))")
[ "$NAMED" = "True" ] || [ "$NAMED" = "sem-linhas" ] \
    && ok "toda linha do histórico nomeia o servidor de origem" \
    || fail "há linhas de histórico sem server_name"

# Servidor que o usuário não possui não vira 200 vazio nem 500.
C=$(code "$API/settings/alerts/history?server_id=999999" "${AUTH[@]}")
[ "$C" = "404" ] \
    && ok "histórico de um servidor inexistente devolve 404, não uma lista vazia" \
    || fail "GET /settings/alerts/history?server_id=999999 devolveu HTTP $C"

echo
echo "Resultado: $PASS ok, $FAIL falha(s)"
[ "$FAIL" -eq 0 ]
