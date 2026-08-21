#!/usr/bin/env bash
# ============================================================
# Teste de aceite — Tarefa 3 (Sessão 1, pós-auditoria)
#
# Prova o critério de aceite pedido: um teste que remove N mensagens,
# restaura da quarentena, e confirma que os MESMOS IDs voltaram pra
# fila. Usa Exim real (via exim-test.sh, o injetor já usado pelo
# projeto) — quarentena depende de copiar os arquivos de spool de
# verdade (-H/-D), não dá pra simular com um binário falso como em
# test_action_verification.sh.
#
# Também cobre plan() (--dry-run=1): confirma que rodar o plano não
# altera nada antes de aplicar de verdade.
#
# Requer root (ou usuário com os mesmos privilégios de spool que este
# host já tem), Exim real instalado e jq.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIAG="$SCRIPT_DIR/diag-exim.sh"
EXIM_TEST="$SCRIPT_DIR/exim-test.sh"
INCIDENT="test-quarantine-$$"

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  OK   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

cleanup() {
    # Restaura qualquer coisa que tenha ficado presa na quarentena de
    # teste antes de limpar a fila — senão o exim-test.sh --clean não
    # vê essas mensagens (não estão mais no spool ativo).
    bash "$DIAG" --action=restore-quarantine:"$INCIDENT" >/dev/null 2>&1 || true
    bash "$EXIM_TEST" --clean >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ── Injeta 3 mensagens reais e captura os IDs exatos ─────────────────
bash "$EXIM_TEST" -n 3 >/dev/null 2>&1
ORIGINAL_IDS=$(exim -bp 2>/dev/null | awk '{print $3}' | grep -E '^[A-Za-z0-9-]{6,}$' | sort)
ORIGINAL_COUNT=$(printf '%s\n' "$ORIGINAL_IDS" | grep -c .)

if [ "$ORIGINAL_COUNT" -eq 3 ]; then
    ok "injeção: 3 mensagens reais na fila"
else
    fail "injeção: esperava 3 mensagens, achou $ORIGINAL_COUNT — abortando o resto do teste"
    echo "── $PASS passou, $FAIL falhou ──"
    exit 1
fi

# ── plan() — dry-run não pode alterar nada ───────────────────────────
PLAN_OUT=$(bash "$DIAG" --action=clean-full --dry-run=1 --actor=test-suite)
echo "$PLAN_OUT" | jq . >/dev/null || fail "plan: JSON inválido"
PLAN_AFFECT=$(echo "$PLAN_OUT" | jq -r '.plan.would_affect')
QUEUE_AFTER_PLAN=$(exim -bpc 2>/dev/null)

if [ "$PLAN_AFFECT" -eq 3 ] && [ "$QUEUE_AFTER_PLAN" -eq 3 ]; then
    ok "plan() reporta 3 mensagens afetadas e não altera a fila (ainda 3)"
else
    fail "plan(): would_affect=$PLAN_AFFECT, fila depois=$QUEUE_AFTER_PLAN (esperava 3 e 3)"
fi

# ── apply() — remove de verdade, quarenteia antes ────────────────────
APPLY_OUT=$(bash "$DIAG" --action=clean-full --incident="$INCIDENT" --actor=test-suite)
echo "$APPLY_OUT" | jq . >/dev/null || fail "apply: JSON inválido"
APPLY_SUCCESS=$(echo "$APPLY_OUT" | jq -r '.success')
QUARANTINE_INCIDENT=$(echo "$APPLY_OUT" | jq -r '.quarantine_incident')
QUEUE_AFTER_APPLY=$(exim -bpc 2>/dev/null)

if [ "$APPLY_SUCCESS" = "true" ] && [ "$QUEUE_AFTER_APPLY" -eq 0 ] && [ "$QUARANTINE_INCIDENT" = "$INCIDENT" ]; then
    ok "apply() remove as 3 mensagens de verdade (fila=0) e registra o incidente de quarentena"
else
    fail "apply(): success=$APPLY_SUCCESS, fila depois=$QUEUE_AFTER_APPLY, incident=$QUARANTINE_INCIDENT"
fi

MANIFEST="/var/spool/exim_quarantine/$INCIDENT/manifest.tsv"
if [ -f "$MANIFEST" ]; then
    MANIFEST_IDS=$(awk -F'\t' '{print $1}' "$MANIFEST" | sort)
    if [ "$MANIFEST_IDS" = "$ORIGINAL_IDS" ]; then
        ok "quarentena guardou exatamente os mesmos 3 IDs removidos"
    else
        fail "quarentena: IDs no manifest não batem com os originais"
    fi
else
    fail "quarentena: manifest.tsv não encontrado em $MANIFEST"
fi

# ── restauração — os MESMOS IDs têm que voltar pra fila ──────────────
RESTORE_OUT=$(bash "$DIAG" --action=restore-quarantine:"$INCIDENT" --actor=test-suite)
echo "$RESTORE_OUT" | jq . >/dev/null || fail "restore: JSON inválido"
RESTORED_IDS=$(echo "$RESTORE_OUT" | jq -r '.restored_ids[]' | sort)
QUEUE_IDS_AFTER_RESTORE=$(exim -bp 2>/dev/null | awk '{print $3}' | grep -E '^[A-Za-z0-9-]{6,}$' | sort)

if [ "$RESTORED_IDS" = "$ORIGINAL_IDS" ] && [ "$QUEUE_IDS_AFTER_RESTORE" = "$ORIGINAL_IDS" ]; then
    ok "restore-quarantine devolve exatamente os mesmos 3 IDs pra fila real"
else
    fail "restore: restored_ids ou fila pós-restore não batem com os IDs originais"
fi

if [ ! -d "/var/spool/exim_quarantine/$INCIDENT" ]; then
    ok "quarentena do incidente removida depois da restauração completa"
else
    fail "quarentena: diretório do incidente ainda existe depois de restaurar tudo"
fi

echo
echo "── $PASS passou, $FAIL falhou ──"
[ "$FAIL" -eq 0 ]
