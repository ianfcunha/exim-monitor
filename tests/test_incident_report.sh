#!/usr/bin/env bash
# ============================================================
# Teste de aceite — Sessão 3, Tarefa 2 (relatório de incidente).
#
# Roda contra o backend real. Cria um incidente sintético com uma ação
# associada (incident_id) e confere que o relatório HTML: exige login
# (mesma auth de toda a API), traz as seções obrigatórias em português
# simples, não referencia nenhum recurso externo (CSS/JS/imagem — tem
# que abrir offline), e reflete a ação executada na seção "o que foi
# feito".
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="http://localhost:8000/api"
COMPOSE="docker compose -f $SCRIPT_DIR/docker-compose.yml"

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

SERVER_ID=$(curl -s "$API/servers" "${AUTH[@]}" | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['id'])")

# Sessão 5 — higiene. Este teste cria incidentes NUM SERVIDOR REAL e a
# limpeza no fim do arquivo só apagava `%__test_legacy_impact__`; os
# `__test_report__` ficavam para trás a cada execução. Cinco deles
# estavam no Cloudez LAB quando a verificação em navegador rodou, e o
# motor de incidentes os resolvia sozinho três ciclos depois — o que
# parecia "algo resolvendo incidentes sem intervenção". Pior: as
# notificações que eles geraram sobreviviam ao incidente e apareciam no
# Histórico de Alertas apontando para um INC-### inexistente.
#
# `trap EXIT` porque limpeza no fim do script só roda quando o script
# chega ao fim — qualquer `set -e` ou Ctrl-C no meio deixava sujeira.
cleanup() {
    $COMPOSE exec -T backend sh -c "PYTHONPATH=/app python3" >/dev/null 2>&1 <<'PYEOF' || true
from app.database import SessionLocal, Incident
db = SessionLocal()
for i in db.query(Incident).filter(Incident.fingerprint.like("%__test_%")).all():
    db.delete(i)   # alert_history.incident_id é ON DELETE CASCADE (migration 024)
db.commit(); db.close()
PYEOF
}
trap cleanup EXIT

SETUP=$($COMPOSE exec -T backend sh -c "PYTHONPATH=/app python3" <<PYEOF
from app.database import SessionLocal, Incident, ActionHistory, record_incident_event
from datetime import datetime, timedelta
db = SessionLocal()
now = datetime.utcnow()
inc = Incident(
    server_id=$SERVER_ID, type="auth_abuse", severity="critico", status="aberto",
    fingerprint="auth_abuse:$SERVER_ID:__test_report__", entity="cliente@exemplo.com",
    first_seen=now - timedelta(hours=1), last_seen=now,
    metrics={"distinct_ips": 7, "auth_count": 300},
    triggered_by={"rule": "auth_abuse.distinct_ips", "observed": 7, "threshold": 3},
    suggested_fix={"description": "Conta cliente@exemplo.com autenticou de 7 IPs diferentes.",
                   "action": {"action": "clean-auth", "param": "cliente@exemplo.com"}},
    evidence={"lines": ["2026-08-22 10:00:00 auth:fail A=login:cliente@exemplo.com H=1.2.3.4"]},
)
db.add(inc); db.commit(); db.refresh(inc)
record_incident_event(db, inc, "opened", actor="system")
db.add(ActionHistory(server_id=$SERVER_ID, actor="admin", action="clean-auth", param="cliente@exemplo.com",
                      success=True, message="3 mensagens quarentenadas", incident_id=inc.id))
db.commit()
print(inc.id)
db.close()
PYEOF
)
INC_ID=$(echo "$SETUP" | tail -1)

# ── sem token, deve recusar (mesma proteção do resto da API) ──
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$API/incidents/$INC_ID/report")
[ "$CODE" = "401" ] && ok "sem token, /report recusa (401) — não é rota pública" || fail "esperava 401 sem token, veio $CODE"

REPORT=$(curl -s "$API/incidents/$INC_ID/report" "${AUTH[@]}")

echo "$REPORT" | grep -q "O que aconteceu"   && ok "seção 'O que aconteceu' presente"   || fail "faltou 'O que aconteceu'"
echo "$REPORT" | grep -q "O que causou"      && ok "seção 'O que causou' presente"      || fail "faltou 'O que causou'"
echo "$REPORT" | grep -q "O que foi feito"   && ok "seção 'O que foi feito' presente"   || fail "faltou 'O que foi feito'"
echo "$REPORT" | grep -q "sem intervenção"   && ok "seção do contrafactual presente"    || fail "faltou o contrafactual"
echo "$REPORT" | grep -q "Evidência técnica" && ok "seção de evidência presente"        || fail "faltou a evidência"
echo "$REPORT" | grep -q "auth:fail"         && ok "linha de evidência real aparece no relatório" || fail "evidência não apareceu"
echo "$REPORT" | grep -q "cliente@exemplo.com" && ok "conta afetada aparece no relatório" || fail "conta afetada não apareceu"
echo "$REPORT" | grep -qi "quarentenadas"    && ok "ação executada (ActionHistory) aparece em 'o que foi feito'" || fail "ação não apareceu"

if echo "$REPORT" | grep -qiE '<(script|link)[^>]*(src|href)="https?://|<img[^>]*src="https?://'; then
    fail "relatório referencia recurso externo — não é autocontido"
else
    ok "nenhuma referência a recurso externo (CSS/JS/imagem) — autocontido"
fi

echo "$REPORT" | grep -q "Mensagens afetadas" && ok "impacto no formato novo renderiza o valor estimável" || fail "impacto estimável não apareceu"

# ── Sessão 4: impacto congelado no formato ANTIGO ───────────────────────────
# A T6 trocou os números soltos de impacto por {estimable,value,basis} /
# {estimable,reason}, mas o relatório continuou lendo o formato antigo e
# devolvia HTTP 500. Os impactos JÁ CONGELADOS no banco seguem no formato
# velho — este é o impact literal do INC-57 (reputação, resolvido), o dado
# real que quebrou a rota:
#   messages_affected: 1     → o "1 mensagem afetada" que reputação nunca
#                              teve como contar (era o defeito nº 3 da T6)
#   delivery_rate_impact_pct: -0.4 → variação POSITIVA (a entrega melhorou)
#                              exibida como impacto de um incidente crítico
echo
echo "── Sessão 4: relatório de impacto congelado no formato antigo ─"

LEGACY_ID=$($COMPOSE exec -T backend sh -c "PYTHONPATH=/app python3" <<PYEOF
from app.database import SessionLocal, Incident
from datetime import datetime, timedelta
db = SessionLocal()
now = datetime.utcnow()
inc = Incident(
    server_id=$SERVER_ID, type="reputation", severity="critico", status="resolvido",
    fingerprint="reputation:$SERVER_ID:__test_legacy_impact__", entity="ip:190.102.43.248",
    first_seen=now - timedelta(hours=2), last_seen=now - timedelta(hours=1),
    resolved_at=now - timedelta(hours=1), resolution="resolvida",
    metrics={"blocklists_listed": ["zen.spamhaus.org"], "zones_checked": 4},
    suggested_fix={"description": "IP listado em zen.spamhaus.org."},
    evidence={"lines": []},
    impact={
        "computed_at": "2026-08-23T00:41:59.749907Z",
        "stuck_over_4h": 0,
        "domains_affected": [],
        "accounts_affected": [],
        "messages_affected": 1,
        "total_open_seconds": 7708,
        "delivery_rate_impact_pct": -0.4,
    },
)
db.add(inc); db.commit(); db.refresh(inc)
print(inc.id)
db.close()
PYEOF
)
LEGACY_ID=$(echo "$LEGACY_ID" | tail -1)

CODE=$(curl -s -o /tmp/legacy_report.html -w '%{http_code}' "$API/incidents/$LEGACY_ID/report" "${AUTH[@]}")
[ "$CODE" = "200" ] && ok "relatório de impacto congelado no formato antigo responde 200 (era 500)" \
                    || fail "impacto no formato antigo devolveu HTTP $CODE"

LEGACY_REPORT=$(cat /tmp/legacy_report.html)
echo "$LEGACY_REPORT" | grep -q "não estimável" \
    && ok "campo sem valor confiável vira 'não estimável', igual à Triagem" \
    || fail "não apareceu 'não estimável' no relatório"

echo "$LEGACY_REPORT" | grep -q "não tem um lote de mensagens próprio" \
    && ok "o motivo do 'não estimável' aparece — não é um rótulo mudo" \
    || fail "'não estimável' apareceu sem o motivo"

echo "$LEGACY_REPORT" | grep -qE "Mensagens afetadas</td><td><strong>1<" \
    && fail "ainda exibe '1 mensagem afetada' para reputação — o número enganoso voltou" \
    || ok "reputação não exibe mais o '1' de mensagens afetadas"

echo "$LEGACY_REPORT" | grep -qi "melhora de 0.4" \
    && fail "ainda exibe a variação positiva como impacto de um incidente crítico" \
    || ok "variação positiva da entrega não vira 'impacto'"

# A limpeza roda no `trap EXIT` definido lá em cima e cobre TODOS os
# fingerprints `__test_*` criados aqui, não só o legacy_impact.

echo
echo "Resultado: $PASS ok, $FAIL falha(s)"
[ "$FAIL" -eq 0 ]
