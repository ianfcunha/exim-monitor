#!/usr/bin/env bash
# ============================================================
# Teste de aceite — indicador de frescor da coleta.
#
# Pedido do piloto: "não tem informação de quanto tempo passou desde a
# última atualização da coleta". O backend passa a expor last_collected_at
# / collection_status em /api/incidents/summary (frota e por servidor) e
# em /api/status/health — a mesma fonte única de health.py — e a UI
# mostra "atualizado há Xs" na Triagem e na casca (toda tela).
#
# Requer: stack de dev de pé, credenciais em backend/.env.
# ============================================================
set -uo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

API="${API:-http://localhost:8000}"
USER="$(grep -oP '^ADMIN_USERNAME=\K.*' backend/.env)"
PASSWORD="$(grep -oP '^ADMIN_PASSWORD=\K.*' backend/.env)"

PASS=0; FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  OK   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

TOKEN="$(curl -s -X POST "$API/api/auth/login" -d "username=$USER&password=$PASSWORD" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')"
[ -n "$TOKEN" ] || { echo "FALHA: login"; exit 1; }
auth() { curl -s -H "Authorization: Bearer $TOKEN" "$@"; }

FIRST_SID="$(auth "$API/api/servers" | python3 -c '
import json,sys
s=json.load(sys.stdin)
print(s[0]["id"] if s else "")')"

echo "── /api/incidents/summary expõe o frescor da coleta ──────────"

auth "$API/api/incidents/summary" | python3 -c '
import json,sys
d=json.load(sys.stdin)
assert "last_collected_at" in d, "falta last_collected_at na frota"
assert "collection_status" in d, "falta collection_status na frota"
for s in d.get("servers", []):
    name = s.get("server_name")
    assert "last_collected_at" in s, "falta last_collected_at em %s" % name
    assert "collection_status" in s, "falta collection_status em %s" % name
print("frota + por servidor OK")
' && ok "campos presentes na frota e em cada servidor" || fail "campos ausentes em /incidents/summary"

if [ -n "$FIRST_SID" ]; then
    SUMMARY="$(auth "$API/api/incidents/summary?server_id=$FIRST_SID")"
    HEALTH="$(auth "$API/api/status/health?server_id=$FIRST_SID")"
    python3 - "$SUMMARY" "$HEALTH" <<'PYEOF' && ok "summary e status/health concordam no last_collected_at" || fail "as duas rotas divergem no frescor"
import json,sys
summ=json.loads(sys.argv[1]); health=json.loads(sys.argv[2])
s = summ["servers"][0] if summ.get("servers") else {}
assert s.get("last_collected_at") == health.get("last_collected_at"), \
    f'{s.get("last_collected_at")!r} != {health.get("last_collected_at")!r}'
assert s.get("collection_status") == health.get("collection_status")
print("ok")
PYEOF
fi

echo
echo "── A UI consome o indicador ─────────────────────────────────"

grep -q "CollectionFreshness" frontend/src/pages/TriagePage.jsx \
    && ok "TriagePage renderiza CollectionFreshness" \
    || fail "TriagePage não usa CollectionFreshness"

grep -q "CollectionFreshness" frontend/src/components/AppShell.jsx \
    && ok "AppShell (casca, toda tela) renderiza CollectionFreshness" \
    || fail "AppShell não usa CollectionFreshness"

grep -q "last_collected_at" frontend/src/components/AppShell.jsx \
    && ok "AppShell lê last_collected_at do summary" \
    || fail "AppShell não lê last_collected_at"

echo
echo "  PASS: $PASS   FAIL: $FAIL"
[ "$FAIL" -eq 0 ]
