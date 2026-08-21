#!/usr/bin/env bash
# ============================================================
# Teste de aceite — Tarefa 1 (Sessão 1, pós-auditoria)
#
# AUDITORIA.md item 3: "-Mrm" rodava sem $SUDO e o "sucesso" reportado
# era a contagem calculada ANTES da tentativa de remover — o painel
# podia dizer "N mensagens removidas" com as N mensagens intactas na
# fila. Este teste prova que isso não acontece mais: usa binários
# `exim4`/`exiqgrep` falsos (sem depender de Exim real nem de root)
# para simular fila + permissão negada, e verifica que
# diag-exim.sh --action=clean-full só reporta success=true quando a
# fila reconsultada depois confirma a remoção.
#
# Requer bash, jq. Assume id -u == 0 (roda direto, sem $SUDO real) —
# é o caso deste repositório em dev/CI; se rodar como usuário comum
# sem sudo sem senha configurado, pule este teste.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIAG="$SCRIPT_DIR/diag-exim.sh"

FAKE_BIN="$(mktemp -d)"
STATE_FILE="$(mktemp)"
trap 'rm -rf "$FAKE_BIN" "$STATE_FILE"' EXIT

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  OK   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

# ── Binários falsos ──────────────────────────────────────────────────
# STATE_FILE = a fila "de verdade" pro fake exim (um message-id por
# linha). MRM_MODE/ALLOWED_ID controlam o comportamento do -Mrm sem
# precisar de um Exim real nem de permissões de spool de verdade:
#   success -> remove tudo que pedirem
#   denied  -> nunca remove nada, sempre falha (permissão negada total)
#   partial -> remove só $ALLOWED_ID, nega o resto
cat > "$FAKE_BIN/exim4" << 'FAKE'
#!/usr/bin/env bash
case "$1" in
  -bp)
    while IFS= read -r id; do
      [ -z "$id" ] && continue
      printf '  4m      2.0K %s <test@example.com>\n' "$id"
      printf '          test@destino.example\n'
    done < "$STATE_FILE"
    ;;
  -Mrm)
    shift
    # diag-exim.sh chama isso via `xargs -P4 -n1` — várias invocações
    # concorrentes deste fake em paralelo. flock serializa a escrita no
    # STATE_FILE compartilhado (senão duas remoções concorrentes se
    # pisam e "perdem" uma remoção só por causa do teste, não por causa
    # do script real — o Exim de verdade não tem essa condição de corrida
    # porque cada mensagem é um arquivo próprio no spool).
    for id in "$@"; do
      case "$MRM_MODE" in
        success)
          flock "$STATE_FILE.lock" bash -c \
            'grep -vxF "$1" "$2" > "$2.tmp" 2>/dev/null; mv "$2.tmp" "$2"' _ "$id" "$STATE_FILE"
          ;;
        partial)
          if [ "$id" = "$ALLOWED_ID" ]; then
            flock "$STATE_FILE.lock" bash -c \
              'grep -vxF "$1" "$2" > "$2.tmp" 2>/dev/null; mv "$2.tmp" "$2"' _ "$id" "$STATE_FILE"
          else
            echo "exim4: Permission denied for $id" >&2
            exit 1
          fi
          ;;
        *)
          echo "exim4: Permission denied for $id" >&2
          exit 1
          ;;
      esac
    done
    ;;
  *) exit 0 ;;
esac
FAKE
chmod +x "$FAKE_BIN/exim4"

# Usado só pelo path de clean-frozen (via exiqgrep -z) neste teste.
cat > "$FAKE_BIN/exiqgrep" << 'FAKE'
#!/usr/bin/env bash
cat "$STATE_FILE" 2>/dev/null || true
FAKE
chmod +x "$FAKE_BIN/exiqgrep"

export STATE_FILE
export PATH="$FAKE_BIN:$PATH"

reset_state() {
    printf '1qAAAA-000001-Aa\n1qAAAA-000002-Bb\n1qAAAA-000003-Cc\n' > "$STATE_FILE"
}

run_clean_full() {
    MRM_MODE="$1" ALLOWED_ID="${2:-}" \
        bash "$DIAG" --action=clean-full --actor=test-suite --snapshot=0
}

# ── Cenário A: remoção com permissão — sucesso de verdade ───────────
reset_state
OUT=$(run_clean_full success)
echo "$OUT" | jq . >/dev/null || fail "clean-full/success: JSON inválido"

SUCCESS=$(echo "$OUT" | jq -r '.success')
MESSAGE=$(echo "$OUT" | jq -r '.message')
REMAINING=$(grep -c . "$STATE_FILE" 2>/dev/null || true); REMAINING=${REMAINING:-0}

if [ "$SUCCESS" = "true" ] && [ "$REMAINING" -eq 0 ]; then
    ok "clean-full com permissão: success=true e fila realmente vazia ($MESSAGE)"
else
    fail "clean-full com permissão: success=$SUCCESS, restantes=$REMAINING ($MESSAGE)"
fi

# ── Cenário B: permissão negada total — nunca pode reportar sucesso ──
reset_state
OUT=$(run_clean_full denied)
echo "$OUT" | jq . >/dev/null || fail "clean-full/denied: JSON inválido"

SUCCESS=$(echo "$OUT" | jq -r '.success')
LEFTOVER_COUNT=$(echo "$OUT" | jq -r '.leftover_ids | length')
REMAINING=$(grep -c . "$STATE_FILE" 2>/dev/null || true); REMAINING=${REMAINING:-0}

if [ "$SUCCESS" = "false" ] && [ "$REMAINING" -eq 3 ] && [ "$LEFTOVER_COUNT" -eq 3 ]; then
    ok "clean-full sem permissão: success=false, 3 mensagens intactas, 3 leftover_ids"
else
    fail "clean-full sem permissão: success=$SUCCESS, restantes=$REMAINING, leftover=$LEFTOVER_COUNT — nunca pode ser 'sucesso, 0 removidas'"
fi

# ── Cenário C: remoção parcial — delta real, não a contagem otimista ─
reset_state
FIRST_ID=$(head -1 "$STATE_FILE")
OUT=$(run_clean_full partial "$FIRST_ID")
echo "$OUT" | jq . >/dev/null || fail "clean-full/partial: JSON inválido"

SUCCESS=$(echo "$OUT" | jq -r '.success')
LEFTOVER_COUNT=$(echo "$OUT" | jq -r '.leftover_ids | length')
REMAINING=$(grep -c . "$STATE_FILE" 2>/dev/null || true); REMAINING=${REMAINING:-0}

if [ "$SUCCESS" = "false" ] && [ "$REMAINING" -eq 2 ] && [ "$LEFTOVER_COUNT" -eq 2 ]; then
    ok "clean-full parcial: success=false, 1 removida de verdade, 2 leftover_ids (delta real, não otimista)"
else
    fail "clean-full parcial: success=$SUCCESS, restantes=$REMAINING, leftover=$LEFTOVER_COUNT"
fi

# ── Cenário D: fila já vazia — sucesso trivial continua funcionando ──
: > "$STATE_FILE"
OUT=$(run_clean_full success)
SUCCESS=$(echo "$OUT" | jq -r '.success')
if [ "$SUCCESS" = "true" ]; then
    ok "clean-full com fila vazia: success=true (0 de 0 não é falha)"
else
    fail "clean-full com fila vazia: esperava success=true, veio $SUCCESS"
fi

echo
echo "── $PASS passou, $FAIL falhou ──"
[ "$FAIL" -eq 0 ]
