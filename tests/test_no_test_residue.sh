#!/usr/bin/env bash
# ============================================================
# Teste de higiene — Sessão 5.
#
# Nasceu de um defeito real: a verificação em navegador encontrou, no
# Histórico de Alertas, "opened" repetido de duas a quatro vezes por
# incidente e "escalated" DEPOIS de "resolved" no mesmo minuto — o que
# parecia coletor concorrente ou eventos fora de ordem. Não era. Era
# resíduo de teste:
#
#   - test_incident_notify.sh limpava AlertHistory por um filtro
#     (`%__test_notify__%`) que nunca casava com o que _record() grava;
#   - test_incident_report.sh criava incidentes `__test_report__` num
#     servidor REAL e só apagava `__test_legacy_impact__`.
#
# Os incidentes órfãos eram então resolvidos sozinhos pelo motor três
# ciclos depois, o que virou a segunda hipótese assustadora do relatório
# ("algo está resolvendo incidentes sem intervenção").
#
# Nenhum dos dois bugs era detectável por um teste do próprio módulo: a
# limpeza que falha não faz assertion nenhuma falhar. Este teste é a
# rede — roda DEPOIS da suíte e falha se qualquer coisa marcada como
# teste sobreviveu no banco.
#
# Uso: rode por último. `bash tests/test_no_test_residue.sh`
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="docker compose -f $SCRIPT_DIR/docker-compose.yml"

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  OK   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

echo "── Resíduo de teste no banco ──"

REPORT=$($COMPOSE exec -T backend sh -c "PYTHONPATH=/app python3" <<'PYEOF'
from app.database import SessionLocal, AlertHistory, Incident, Server

db = SessionLocal()

# 1) incidentes de fixture (fingerprint/entidade com marca __test)
incs = db.query(Incident).filter(
    Incident.fingerprint.like("%__test%") | Incident.entity.like("%__test%")
).all()
print(f"incidentes\t{len(incs)}\t" + ",".join(str(i.id) for i in incs[:10]))

# 2) servidores de fixture
srvs = db.query(Server).filter(Server.name.like("%__test%")).all()
print(f"servidores\t{len(srvs)}\t" + ",".join(s.name for s in srvs[:10]))

# 3) notificações órfãs — apontam para um INC-### que não existe mais.
#    É o que a interface mostrava como alerta duplicado: linhas de
#    incidentes já apagados, que ninguém consegue abrir.
orphans = []
for row in db.query(AlertHistory).filter(AlertHistory.problem.like("%:INC-%")).all():
    inc_id = row.problem.rsplit(":INC-", 1)[-1]
    if not inc_id.isdigit() or db.get(Incident, int(inc_id)) is None:
        orphans.append(row.id)
print(f"orfas\t{len(orphans)}\t" + ",".join(str(i) for i in orphans[:10]))

db.close()
PYEOF
)

check_zero() {
    local key="$1" label="$2"
    local line count sample
    line=$(echo "$REPORT" | grep "^$key" || true)
    count=$(echo "$line" | cut -f2)
    sample=$(echo "$line" | cut -f3)
    if [ "${count:-0}" -eq 0 ]; then
        ok "$label"
    else
        fail "$label — sobraram $count (${sample:-sem amostra})"
    fi
}

check_zero incidentes "nenhum incidente de fixture sobreviveu à suíte"
check_zero servidores "nenhum servidor de fixture sobreviveu à suíte"
check_zero orfas      "nenhuma notificação aponta para um incidente inexistente"

echo
echo "Resultado: $PASS ok, $FAIL falha(s)"
[ "$FAIL" -eq 0 ]
