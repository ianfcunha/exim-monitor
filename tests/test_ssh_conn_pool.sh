#!/usr/bin/env bash
# ============================================================
# Teste de aceite — pool de conexões SSH (ssh.py)
#
# Prova o que o piloto i7 Host pediu: o backend não pode abrir um login
# SSH por comando. O lfd do CSF manda um e-mail "SSH login alert for user
# mailiq" por login aceito — com 3+ comandos a cada 30s isso enche a fila
# do Exim.
#
# Roda dentro do container backend (mesma conexão .env: 172.17.0.1:22).
# Conta "Accepted publickey" no auth.log do host antes/depois de N
# execuções remotas: com o pool, N execuções => 1 login (a 1ª), não N.
#
# Requer: stack de dev de pé, /var/log/auth.log legível, SSH .env do
# backend funcionando (o mesmo que os outros testes de API usam).
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE="docker compose -f $SCRIPT_DIR/docker-compose.yml"
AUTH_LOG=/var/log/auth.log
N=6

PASS=0; FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  OK   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

[ -r "$AUTH_LOG" ] || { echo "SKIP: $AUTH_LOG não legível"; exit 0; }

# IP de origem do container backend — isola a contagem de logins de
# qualquer outro SSH que aconteça na janela do teste.
SRC_IP=$($COMPOSE exec -T backend sh -c "getent hosts \$(hostname) | awk '{print \$1}'" | tr -d '\r')
[ -n "$SRC_IP" ] || SRC_IP=""
_count_logins() {
    if [ -n "$SRC_IP" ]; then
        grep -E "Accepted .* from ${SRC_IP} " "$AUTH_LOG" | grep -c "" || true
    else
        grep -c "Accepted " "$AUTH_LOG" || true
    fi
}

before=$(_count_logins)

# N execuções remotas reais pela mesma API que o coletor usa (_run_raw).
$COMPOSE exec -T backend python -c "
from app.ssh import _run_raw, close_all_pooled, _pool
for i in range($N):
    out = _run_raw('echo pool-test-\$\$', timeout=10)
    assert 'pool-test' in out, out
assert len(_pool) == 1, f'esperava 1 conexão no pool, tem {len(_pool)}'
print('exec remoto OK, pool =', list(_pool))
close_all_pooled()
assert len(_pool) == 0, 'pool não esvaziou no close_all_pooled'
print('close_all_pooled OK')
" || { fail "execução remota dentro do container"; echo "PASS=$PASS FAIL=$FAIL"; exit 1; }
ok "$N execuções remotas + close_all_pooled"

sleep 1
after=$(_count_logins)
delta=$((after - before))

echo "  logins SSH aceitos durante o teste: $delta (de $N execuções)"
if [ "$delta" -le 2 ]; then
    ok "pool reaproveita a conexão ($delta login(s) para $N comandos)"
else
    fail "abriu $delta logins para $N comandos — pool não está reaproveitando"
fi

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
