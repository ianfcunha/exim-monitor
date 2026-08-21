#!/usr/bin/env bash
# ============================================================
# Teste de aceite — Tarefa 5 (Sessão 1, pós-auditoria).
#
# As funções do menu interativo (clean_full/clean_frozen/clean_bounces/
# clean_by_sender/clean_by_auth_user) duplicavam a lógica destrutiva sem
# $SUDO, sem $EXIM_BIN (literal "exim" — quebra em Debian/Ubuntu) e sem
# verificação nem quarentena. Agora roteiam por _menu_removal_result() →
# _remove_ids_verified(), o mesmo núcleo que execute_action() usa.
#
# Este teste: (1) garante por grep que o padrão quebrado não voltou
# (guarda estática), e (2) chama as funções do menu de verdade — com
# Exim real — pra confirmar que elas removem, quarentenam e restauram
# como as ações via API já fazem.
#
# Técnica pra testar as funções sem disparar o loop interativo: o
# script chama `main` incondicionalmente na última linha — geramos uma
# cópia com essa linha neutralizada e usamos `source` nela, então
# chamamos as funções diretamente. Requer Exim real e jq.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIAG="$SCRIPT_DIR/diag-exim.sh"
EXIM_TEST="$SCRIPT_DIR/exim-test.sh"
SOURCEABLE="$(mktemp)"

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  OK   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

cleanup() {
    bash "$EXIM_TEST" --clean >/dev/null 2>&1 || true
    rm -f "$SOURCEABLE"
    rm -rf /var/spool/exim_quarantine/menu-test-* 2>/dev/null || true
}
trap cleanup EXIT

# ── Guarda estática: literal "exim -Mrm"/"exim -qff" (sem $EXIM_BIN)
# não pode reaparecer nas funções do menu ──────────────────────────
if grep -nE '^\s*exim (-bp|-Mrm|-qff|-Mvh)\b' "$DIAG" | grep -v '\$SUDO'; then
    fail "diag-exim.sh ainda tem chamada a 'exim' literal (sem \$EXIM_BIN) — regressão do item do menu na Tarefa 5"
else
    ok "nenhuma chamada a 'exim' literal (sem \$EXIM_BIN) no script"
fi

# ── Prepara uma cópia sourceável (neutraliza a chamada final a main) ─
sed '$ s/^main$/: # main desabilitado para teste/' "$DIAG" > "$SOURCEABLE"

# ── Cenário: clean_frozen() sem nada frozen — sucesso trivial ────────
OUT=$(bash -c "
    source '$SOURCEABLE' --quick >/dev/null 2>&1
    RESET=''; GREEN=''; YELLOW=''; RED=''; DIM=''
    clean_frozen
" 2>&1)
echo "$OUT" | grep -qF "0 mensagem(ns) removida(s)" && ok "clean_frozen() sem frozen: reporta 0 removidas (sucesso trivial)" \
    || fail "clean_frozen() sem frozen: saída inesperada: $OUT"

# ── Cenário: clean_full() remove mensagens reais, quarentena, restaura ─
bash "$EXIM_TEST" -n 2 >/dev/null 2>&1
ORIGINAL_IDS=$(exim -bp 2>/dev/null | awk '{print $3}' | grep -E '^[A-Za-z0-9-]{6,}$' | sort)

OUT=$(bash -c "
    source '$SOURCEABLE' --quick >/dev/null 2>&1
    RESET=''; GREEN=''; YELLOW=''; RED=''; DIM=''
    clean_full
" 2>&1)
QUEUE_AFTER=$(exim -bpc 2>/dev/null)
INCIDENT=$(echo "$OUT" | grep -oE 'menu-[0-9]+-[0-9]+' | head -1)

if echo "$OUT" | grep -qF "[OK] Fila limpa" && [ "$QUEUE_AFTER" -eq 0 ] && [ -n "$INCIDENT" ]; then
    ok "clean_full() do menu remove de verdade (fila=0) e cria incidente de quarentena ($INCIDENT)"
else
    fail "clean_full() do menu: fila_depois=$QUEUE_AFTER incident=$INCIDENT saída: $OUT"
fi

if [ -n "$INCIDENT" ]; then
    RESTORE_OUT=$(bash "$DIAG" --action=restore-quarantine:"$INCIDENT" --actor=test-suite)
    RESTORED_IDS=$(echo "$RESTORE_OUT" | jq -r '.restored_ids[]' | sort)
    if [ "$RESTORED_IDS" = "$ORIGINAL_IDS" ]; then
        ok "restore-quarantine devolve os mesmos IDs removidos pelo menu"
    else
        fail "restore: IDs restaurados não batem com os originais"
    fi
fi

echo
echo "── $PASS passou, $FAIL falhou ──"
[ "$FAIL" -eq 0 ]
