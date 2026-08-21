#!/usr/bin/env bash
# ============================================================
# Teste de aceite — Tarefa 4 (Sessão 1, pós-auditoria), sondagem de
# capacidade.
#
# Prova que --check reporta cap_remove_messages/cap_manage_firewall/
# cap_write_blacklist/cap_quarantine corretamente nos 3 cenários que
# importam: usuário sem sudo nenhum (tudo false), usuário com sudo
# parcial (só o que está na allowlist dele), root (tudo true).
#
# Pego um bug real testando isto manualmente antes de escrever o
# teste: `grep -qF "-Mrm"` sem "--" faz o grep interpretar "-Mrm"
# como opção ("invalid option -- 'M'") e a checagem falha sempre,
# mesmo com o sudoers concedendo exatamente esse comando — por isso
# o cenário "sudo parcial" abaixo é o mais importante dos três.
#
# Cria e remove um usuário de sistema descartável
# (mailiq-capprobe-test) e um /etc/sudoers.d temporário — requer
# root. Sempre limpa via trap, mesmo se o teste falhar no meio.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIAG="$SCRIPT_DIR/diag-exim.sh"
TEST_USER="mailiq-capprobe-test"
SUDOERS_FILE="/etc/sudoers.d/${TEST_USER}"

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  OK   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

if [ "$(id -u)" -ne 0 ]; then
    echo "Requer root (precisa criar usuário de sistema + sudoers) — pulando."
    exit 0
fi

cleanup() {
    rm -f "$SUDOERS_FILE"
    userdel "$TEST_USER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

useradd -M -s /usr/sbin/nologin "$TEST_USER"

cap_value() {
    # $1 = saída JSON do --check, $2 = nome do check
    echo "$1" | jq -r --arg c "$2" '.checks[] | select(.check == $c) | .ok'
}

# ── Cenário A: sem sudo nenhum — tudo tem que ser false ──────────────
OUT=$(sudo -u "$TEST_USER" bash "$DIAG" --check 2>/dev/null)
echo "$OUT" | jq . >/dev/null || fail "cenário A: JSON inválido"
ALL_FALSE=true
for c in cap_remove_messages cap_manage_firewall cap_write_blacklist cap_quarantine; do
    [ "$(cap_value "$OUT" "$c")" = "false" ] || ALL_FALSE=false
done
$ALL_FALSE && ok "sem sudo: as 4 capacidades reportam false" \
    || fail "sem sudo: esperava as 4 capacidades false, saída: $OUT"

# ── Cenário B: sudo parcial (só -Mrm e iptables) — mistura true/false ─
cat > "$SUDOERS_FILE" <<EOF
$TEST_USER ALL=(root) NOPASSWD: /usr/sbin/exim4 -Mrm *, /usr/sbin/iptables -I INPUT *
EOF
chmod 440 "$SUDOERS_FILE"
visudo -c -f "$SUDOERS_FILE" >/dev/null 2>&1 || fail "sudoers de teste inválido (visudo -c)"

OUT=$(sudo -u "$TEST_USER" bash "$DIAG" --check 2>/dev/null)
RM=$(cap_value "$OUT" cap_remove_messages)
FW=$(cap_value "$OUT" cap_manage_firewall)
BL=$(cap_value "$OUT" cap_write_blacklist)
QR=$(cap_value "$OUT" cap_quarantine)

if [ "$RM" = "true" ] && [ "$FW" = "true" ] && [ "$BL" = "false" ] && [ "$QR" = "false" ]; then
    ok "sudo parcial: cap_remove_messages e cap_manage_firewall=true (concedidos), os outros dois=false (não concedidos)"
else
    fail "sudo parcial: rm=$RM fw=$FW bl=$BL qr=$QR (esperava true,true,false,false)"
fi

# ── Cenário C: root — tudo true, sem depender de sudoers ─────────────
OUT=$(bash "$DIAG" --check 2>/dev/null)
ALL_TRUE=true
for c in cap_remove_messages cap_manage_firewall cap_write_blacklist cap_quarantine; do
    [ "$(cap_value "$OUT" "$c")" = "true" ] || ALL_TRUE=false
done
$ALL_TRUE && ok "root: as 4 capacidades reportam true" \
    || fail "root: esperava as 4 capacidades true, saída: $OUT"

echo
echo "── $PASS passou, $FAIL falhou ──"
[ "$FAIL" -eq 0 ]
