#!/usr/bin/env bash
# ============================================================
# Teste de aceite — Sessão 3, Tarefa 3 (relatório mensal por servidor/frota).
#
# Roda dentro do container backend (import direto, sem HTTP) — o cálculo
# do relatório é lógica pura de banco, mesmo padrão de validação usado
# pra build_weekly_report em sessões anteriores. Cria um servidor
# descartável (mesma técnica de isolamento do test_incident_impact.sh)
# com incidentes/snapshots/ações sintéticos no "mês anterior" simulado,
# e confere os números exatos que build_monthly_report()/
# build_fleet_monthly_report() devolvem.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="docker compose -f $SCRIPT_DIR/docker-compose.yml"
ADMIN_USER=$(grep '^ADMIN_USERNAME=' "$SCRIPT_DIR/backend/.env" | cut -d= -f2)

OUT=$($COMPOSE exec -T backend sh -c "PYTHONPATH=/app python3" <<PYEOF
from app.database import SessionLocal, Server, User, Incident, Snapshot, ActionHistory, record_incident_event
from app.monthly_report import build_monthly_report, build_fleet_monthly_report, _previous_month_period
from datetime import datetime, timedelta

db = SessionLocal()
owner_id = db.query(User).filter(User.username == "$ADMIN_USER").first().id
server = Server(owner_id=owner_id, name="__test_monthly__", host="127.0.0.1", ssh_user="mailiq", ssh_auth_type="key")
db.add(server); db.commit(); db.refresh(server)
sid = server.id

start, end = _previous_month_period()
mid = start + (end - start) / 2

# 2 incidentes auth_abuse (1 resolvido em 2h, 1 ainda aberto), 1 reputation/blocklist resolvido em 5h
inc1 = Incident(server_id=sid, type="auth_abuse", severity="critico", status="resolvido",
                 fingerprint=f"auth_abuse:{sid}:a", entity="a@x.com",
                 first_seen=mid, last_seen=mid, resolved_at=mid + timedelta(hours=2))
inc2 = Incident(server_id=sid, type="auth_abuse", severity="critico", status="aberto",
                 fingerprint=f"auth_abuse:{sid}:b", entity="b@x.com",
                 first_seen=mid, last_seen=mid)
inc3 = Incident(server_id=sid, type="reputation", severity="critico", status="resolvido",
                 fingerprint=f"reputation:{sid}:ip", entity="ip:1.2.3.4",
                 first_seen=mid, last_seen=mid, resolved_at=mid + timedelta(hours=5),
                 metrics={"blocklists_listed": ["zen.spamhaus.org"], "ip": "1.2.3.4"})
db.add_all([inc1, inc2, inc3]); db.commit()
for i in (inc1, inc2, inc3):
    record_incident_event(db, i, "opened", actor="system")
db.commit()

# ação de restauração de quarentena com 5 mensagens, dentro do período
db.add(ActionHistory(server_id=sid, actor="admin", action="restore-quarantine", param="x",
                      success=True, message="5 mensagem(ns) restaurada(s) da quarentena 'x'", executed_at=mid))
db.commit()

# snapshots pra evolução de entrega (2 semanas do período com dados)
db.add(Snapshot(server_id=sid, timestamp=start + timedelta(days=1), mode="full", delivered=90, rejected=10))
db.add(Snapshot(server_id=sid, timestamp=start + timedelta(days=20), mode="full", delivered=70, rejected=30))
db.commit()

report = build_monthly_report(db, sid)
assert report["incidents_by_type"] == {"auth_abuse": 2, "reputation": 1}, report["incidents_by_type"]
assert report["mttr_seconds"] == 3600 * (2 + 5) / 2, report["mttr_seconds"]  # só os 2 resolvidos (inc1=2h, inc3=5h)
assert report["messages_recovered_from_quarantine"] == 5, report["messages_recovered_from_quarantine"]
assert report["total_time_in_blocklist_seconds"] == 5 * 3600, report["total_time_in_blocklist_seconds"]
assert len(report["delivery_rate_evolution"]) >= 4, report["delivery_rate_evolution"]
assert report["delivery_rate_evolution"][0]["delivery_rate"] == 90.0
print("OK_SERVER_REPORT")

fleet = build_fleet_monthly_report(db)
names = [s["server_name"] for s in fleet["per_server"]]
assert "__test_monthly__" in names, names
match = next(s for s in fleet["per_server"] if s["server_id"] == sid)
assert match["incidents_by_type"] == {"auth_abuse": 2, "reputation": 1}
print("OK_FLEET_REPORT")

db.delete(server); db.commit()
db.close()
print("OK_CLEANUP")
PYEOF
)

PASS=0; FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  OK   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

echo "$OUT" | grep -q "OK_SERVER_REPORT" && ok "build_monthly_report: incidentes por tipo, MTTR, quarentena, blocklist e evolução corretos" || fail "build_monthly_report deu número errado"
echo "$OUT" | grep -q "OK_FLEET_REPORT"  && ok "build_fleet_monthly_report inclui o servidor no breakdown por servidor" || fail "build_fleet_monthly_report não incluiu o servidor"
echo "$OUT" | grep -q "OK_CLEANUP"       && ok "servidor descartável limpo no final" || fail "cleanup falhou"

if ! echo "$OUT" | grep -q "OK_CLEANUP"; then
    echo "--- saída completa (pra depurar) ---"
    echo "$OUT"
fi

echo
echo "Resultado: $PASS ok, $FAIL falha(s)"
[ "$FAIL" -eq 0 ]
