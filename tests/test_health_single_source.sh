#!/usr/bin/env bash
# ============================================================
# Teste de aceite — Sessão 4, Tarefa 5 (uma fonte de verdade).
#
# O defeito: no mesmo instante e para o mesmo servidor, a Triagem dizia
# "Entrega degradada — 2 incidentes ativos" e o painel clássico exibia
# "DIAGNÓSTICO ● OK" em verde. Eram dois cálculos independentes — a
# Triagem contava incidentes, o painel lia o campo `severity` do último
# snapshot de coleta.
#
# Este teste bate as DUAS rotas de verdade, pela API real e logado, e
# exige que concordem campo a campo. Depois força uma divergência
# artificial (um snapshot com severity=OK gravado enquanto há incidente
# crítico aberto) e exige que o painel continue concordando com a
# Triagem — provando que ele não voltou a ler o snapshot.
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

TOKEN="$(curl -s -X POST "$API/api/auth/login" \
    -d "username=$USER&password=$PASSWORD" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["access_token"])')"
[ -n "$TOKEN" ] || { echo "FALHA: não foi possível autenticar na API"; exit 1; }

auth() { curl -s -H "Authorization: Bearer $TOKEN" "$@"; }

SERVER_IDS="$(auth "$API/api/servers" | python3 -c '
import json,sys
print(" ".join(str(s["id"]) for s in json.load(sys.stdin)))')"

echo "── As duas telas concordam, servidor a servidor ───────────────"

for SID in $SERVER_IDS; do
    TRIAGE="$(auth "$API/api/incidents/summary?server_id=$SID")"
    PANEL="$(auth "$API/api/status/health?server_id=$SID")"

    RESULT="$(python3 - "$SID" <<PYEOF
import json, sys
sid = sys.argv[1]
triage = json.loads('''$TRIAGE''')
panel  = json.loads('''$PANEL''')

# A triagem por servidor devolve a frota reduzida a um servidor; o
# estado agregado tem que bater com o do próprio servidor.
t = triage["servers"][0] if triage.get("servers") else {}
diffs = []
for field in ("state", "headline", "open_critico", "open_atencao"):
    if triage.get(field) != panel.get(field):
        diffs.append(f"{field}: triagem={triage.get(field)!r} painel={panel.get(field)!r}")
    if t.get(field) != panel.get(field):
        diffs.append(f"{field} (por servidor): triagem={t.get(field)!r} painel={panel.get(field)!r}")

t_ids = sorted(i["display_id"] for i in t.get("incidents", []))
p_ids = sorted(i["display_id"] for i in panel.get("incidents", []))
if t_ids != p_ids:
    diffs.append(f"incidentes: triagem={t_ids} painel={p_ids}")

print("|".join(diffs) if diffs else f"OK {panel.get('state')} {panel.get('headline')}")
PYEOF
)"
    if [[ "$RESULT" == OK* ]]; then
        ok "servidor $SID — ${RESULT#OK }"
    else
        fail "servidor $SID divergiu → ${RESULT//|/ ; }"
    fi
done

echo
echo "── Divergência forçada: snapshot 'OK' com incidente crítico aberto ──"

# Grava um snapshot dizendo que está tudo bem — era exatamente esse
# campo que o painel clássico lia — e confere que o selo não muda.
FORCED="$(docker compose exec -T backend sh -c 'PYTHONPATH=/app python3 -' <<'PYEOF'
import json
from datetime import datetime
from app.database import Incident, Server, Snapshot, SessionLocal, User
from app.health import compute_server_health

db = SessionLocal()
owner = db.query(User).filter(User.role == "admin").first()
server = Server(owner_id=owner.id, name="__test_single_source__", host="127.0.0.1",
                port=22, ssh_user="nobody", ssh_auth_type="key", ssh_secret="",
                script_path="/nonexistent", is_enabled=False)
db.add(server); db.commit(); db.refresh(server)
sid = server.id
try:
    now = datetime.utcnow()
    db.add(Incident(server_id=sid, type="queue_stuck", subtype="fila", severity="critico",
                    status="aberto", fingerprint=f"queue_stuck:fila:{sid}:geral", entity="geral",
                    first_seen=now, last_seen=now, metrics={"queue_total": 900},
                    triggered_by={"rule": "queue_stuck.consecutive_growth", "observed": 900}))
    # O snapshot mente: severity OK, problem NORMAL.
    db.add(Snapshot(server_id=sid, timestamp=now, mode="full", severity="OK",
                    problem="NORMAL", queue_total=0, data={"queue": {"total": 0}}))
    db.commit()
    health = compute_server_health(db, sid, server.name)
    print(json.dumps({"state": health["state"], "headline": health["headline"],
                      "incidents": [i["display_id"] for i in health["incidents"]]}))
finally:
    db.query(Snapshot).filter(Snapshot.server_id == sid).delete(synchronize_session=False)
    db.query(Incident).filter(Incident.server_id == sid).delete(synchronize_session=False)
    db.query(Server).filter(Server.id == sid).delete(synchronize_session=False)
    db.commit(); db.close()
PYEOF
)"
FORCED="$(printf '%s' "$FORCED" | grep -v '^time=' | tail -1)"

STATE="$(printf '%s' "$FORCED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["state"])' 2>/dev/null || echo "?")"
if [ "$STATE" = "critico" ]; then
    ok "com um snapshot dizendo OK e um incidente crítico aberto, o estado é crítico"
else
    fail "o snapshot 'OK' venceu o incidente crítico — estado calculado: '$STATE' ($FORCED)"
fi

echo
echo "── Guarda estática: o painel não pode ter cálculo próprio ─────"

if grep -rn "SEVERITY_MAP\[.*severity.*\] ?? " frontend/src/pages/Dashboard.jsx >/dev/null 2>&1; then
    fail "Dashboard.jsx voltou a derivar o selo do severity do snapshot"
else
    ok "Dashboard.jsx não deriva o selo de saúde do snapshot de coleta"
fi

echo
echo "════════════════════════════════════════════════════════"
echo "  PASS: $PASS   FAIL: $FAIL"
echo "════════════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ]
