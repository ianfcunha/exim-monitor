#!/usr/bin/env bash
# ============================================================
# Teste de aceite — Tarefa 6 (Sessão 1, pós-auditoria).
#
# AUDITORIA.md item 6: alimentar um log de formato desconhecido tinha
# que fazer o painel dizer "0 mensagens"/"OK" — o critério de aceite
# pedido é que isso vire "não consigo ler este log" (DEGRADED),
# nunca 0-silencioso nem NORMAL.
#
# Usa as fixtures em tests/fixtures/ (ver docs/compatibilidade.md) e a
# mesma técnica de test_menu_dedup.sh — sourcing do script com a
# chamada final a main() neutralizada — pra chamar analyze_log()/
# classify() diretamente com LOG_SAMPLE controlado, sem precisar
# trocar o mainlog real do host.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIAG="$SCRIPT_DIR/diag-exim.sh"
FIXTURES="$SCRIPT_DIR/tests/fixtures"
SOURCEABLE="$(mktemp)"

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  OK   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

cleanup() { rm -f "$SOURCEABLE"; }
trap cleanup EXIT

sed '$ s/^main$/: # main desabilitado para teste/' "$DIAG" > "$SOURCEABLE"

run_classify() {
    # $1 = arquivo de log a usar como LOG_SAMPLE. Imprime
    # "PROBLEM|SEVERITY|LOG_LINES_TOTAL|LOG_LINES_RECOGNIZED|LOG_RECOGNITION_PCT".
    #
    # classify() sozinho (sem passar por collect()/analyze_senders/
    # analyze_age antes) referencia variáveis que só analyze_log()
    # preenche pra este teste — QUEUE/TOP_SENDER_COUNT/RELAY_SUSPECT_*
    # ficam vazias, e cada "[ "" -gt N ]" solto imprime "integer
    # expression expected" no stderr. Inofensivo (bash trata como
    # falso e o elif segue normalmente — é exatamente o comportamento
    # que os cenários abaixo verificam), só ruído de rodar classify()
    # isolado — por isso 2>/dev/null aqui.
    local logfile="$1"
    bash -c "
        source '$SOURCEABLE' --quick >/dev/null 2>&1
        LOG_SAMPLE=\$(cat '$logfile')
        analyze_log
        classify
        echo \"\${PROBLEM}|\${SEVERITY}|\${LOG_LINES_TOTAL}|\${LOG_LINES_RECOGNIZED}|\${LOG_RECOGNITION_PCT}\"
    " 2>/dev/null
}

# ── Cenário A: log real, formato conhecido — nunca fica em UNKNOWN/DEGRADED ─
RESULT=$(run_classify "$FIXTURES/debian_exim4_normal.log")
IFS='|' read -r PROBLEM SEVERITY TOTAL RECOGNIZED PCT <<< "$RESULT"
if [ "$SEVERITY" != "DEGRADED" ] && [ "$SEVERITY" != "UNKNOWN" ] && [ "$PCT" -ge 80 ]; then
    ok "log real (Debian/Ubuntu exim4): reconhecimento ${PCT}%, severity=${SEVERITY} (não degradado)"
else
    fail "log real: esperava severity != DEGRADED/UNKNOWN e pct>=80, veio problem=$PROBLEM severity=$SEVERITY pct=$PCT"
fi

# ── Cenário B: formato desconhecido — tem que virar DEGRADED, nunca OK ──────
RESULT=$(run_classify "$FIXTURES/unknown_format.log")
IFS='|' read -r PROBLEM SEVERITY TOTAL RECOGNIZED PCT <<< "$RESULT"
if [ "$SEVERITY" = "DEGRADED" ] && [ "$PROBLEM" = "LOG_NAO_RECONHECIDO" ] && [ "$SEVERITY" != "OK" ]; then
    ok "formato desconhecido: severity=DEGRADED, problem=LOG_NAO_RECONHECIDO (nunca 'OK')"
else
    fail "formato desconhecido: esperava DEGRADED/LOG_NAO_RECONHECIDO, veio problem=$PROBLEM severity=$SEVERITY pct=$PCT"
fi

# ── Cenário C: zero linhas lidas (mainlog vazio/inacessível) — DEGRADED ────
: > /tmp/empty_log_test.$$
RESULT=$(run_classify "/tmp/empty_log_test.$$")
rm -f /tmp/empty_log_test.$$
IFS='|' read -r PROBLEM SEVERITY TOTAL RECOGNIZED PCT <<< "$RESULT"
if [ "$SEVERITY" = "DEGRADED" ] && [ "$TOTAL" -eq 0 ]; then
    ok "zero linhas lidas: severity=DEGRADED (nunca finge fila vazia = tudo normal)"
else
    fail "zero linhas: esperava DEGRADED com total=0, veio problem=$PROBLEM severity=$SEVERITY total=$TOTAL"
fi

# ── Cenário D: classify() nunca retorna PROBLEM/SEVERITY literalmente
# "UNKNOWN" no resultado final — ou resolve pra DEGRADED (log ruim) ou
# pra um diagnóstico real (log bom). UNKNOWN como saída final seria bug.
for f in "$FIXTURES/debian_exim4_normal.log" "$FIXTURES/unknown_format.log"; do
    RESULT=$(run_classify "$f")
    IFS='|' read -r PROBLEM SEVERITY TOTAL RECOGNIZED PCT <<< "$RESULT"
    if [ "$PROBLEM" != "UNKNOWN" ] && [ "$SEVERITY" != "UNKNOWN" ]; then
        ok "classify() resolve além de UNKNOWN pra $(basename "$f") (problem=$PROBLEM)"
    else
        fail "classify() ficou em UNKNOWN pra $(basename "$f") — deveria ter caído em DEGRADED ou num diagnóstico real"
    fi
done

echo
echo "── $PASS passou, $FAIL falhou ──"
[ "$FAIL" -eq 0 ]
