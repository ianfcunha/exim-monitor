#!/usr/bin/env bash
# ============================================================
# Teste de aceite — Tarefa 2 (Sessão 1, pós-auditoria)
#
# AUDITORIA.md item 2: _block_ip_persist() reiniciava firewall.service
# inteiro a cada bloqueio de IP — gerador de incidente num host de
# produção. Este teste prova, com iptables real (sem CSF/firewalld
# neste host, então exercita o fallback), que:
#   - bloquear e desbloquear nunca chama `systemctl restart` de nada
#   - o TTL expira sozinho via --action=expire-blocks
#   - --action=unblock-ip --tool=iptables desfaz o bloqueio manualmente
#
# Usa endereços da faixa reservada a documentação (RFC 5737,
# 203.0.113.0/24) — nunca roteável de verdade, seguro pra manipular
# regras reais de iptables neste host. Requer root (ou sudo sem senha)
# e jq.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIAG="$SCRIPT_DIR/diag-exim.sh"

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  OK   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

cleanup_ip() {
    iptables -D INPUT -s "$1" -j DROP >/dev/null 2>&1 || true
    if [ -f /var/log/exim-monitor/ip_blocks.tsv ]; then
        grep -vF "$1" /var/log/exim-monitor/ip_blocks.tsv > /tmp/ip_blocks.tsv.clean 2>/dev/null || true
        mv /tmp/ip_blocks.tsv.clean /var/log/exim-monitor/ip_blocks.tsv 2>/dev/null || true
    fi
    [ -f /etc/firewall.d/03_custom ] && sed -i "\#${1}#d" /etc/firewall.d/03_custom 2>/dev/null || true
}
trap 'cleanup_ip 203.0.113.201; cleanup_ip 203.0.113.202' EXIT

# ── Guard estático: nunca mais pode reintroduzir o restart ──────────
if grep -q "systemctl restart" "$DIAG"; then
    fail "diag-exim.sh chama 'systemctl restart' em algum lugar — regressão do item 2 da auditoria"
else
    ok "nenhuma chamada a 'systemctl restart' no script"
fi

# ── Cenário A: bloqueio manual (unblock-ip --tool=iptables) ─────────
IP_A="203.0.113.201"
cleanup_ip "$IP_A"

OUT=$(bash "$DIAG" --action=block-ip:"$IP_A" --ttl=999 --actor=test-suite --snapshot=0)
echo "$OUT" | jq . >/dev/null || fail "block-ip: JSON inválido"
SUCCESS=$(echo "$OUT" | jq -r '.success')

if [ "$SUCCESS" = "true" ] && iptables -C INPUT -s "$IP_A" -j DROP >/dev/null 2>&1; then
    ok "block-ip aplica a regra iptables ao vivo, sem restart"
else
    fail "block-ip: success=$SUCCESS, regra iptables ausente"
fi

OUT=$(bash "$DIAG" --action=list-blocks)
COUNT=$(echo "$OUT" | jq -r --arg ip "$IP_A" '[.blocks[] | select(.ip == $ip)] | length')
[ "$COUNT" -eq 1 ] && ok "list-blocks mostra o bloqueio ativo com TTL restante" \
    || fail "list-blocks: esperava 1 entrada pra $IP_A, achou $COUNT"

OUT=$(bash "$DIAG" --action=unblock-ip --ip="$IP_A" --tool=iptables)
SUCCESS=$(echo "$OUT" | jq -r '.success')
if [ "$SUCCESS" = "true" ] && ! iptables -C INPUT -s "$IP_A" -j DROP >/dev/null 2>&1; then
    ok "unblock-ip --tool=iptables remove a regra de verdade"
else
    fail "unblock-ip --tool=iptables: regra ainda presente ou success=$SUCCESS"
fi

# ── Cenário B: expiração automática (TTL curto + expire-blocks) ─────
IP_B="203.0.113.202"
cleanup_ip "$IP_B"

bash "$DIAG" --action=block-ip:"$IP_B" --ttl=1 --actor=test-suite --snapshot=0 >/dev/null
sleep 2
OUT=$(bash "$DIAG" --action=expire-blocks)
echo "$OUT" | jq . >/dev/null || fail "expire-blocks: JSON inválido"
EXPIRED=$(echo "$OUT" | jq -r --arg ip "$IP_B" '.expired_ips | index($ip) != null')

if [ "$EXPIRED" = "true" ] && ! iptables -C INPUT -s "$IP_B" -j DROP >/dev/null 2>&1; then
    ok "expire-blocks remove sozinho um bloqueio cujo TTL venceu"
else
    fail "expire-blocks: $IP_B não foi expirado/removido como esperado"
fi

echo
echo "── $PASS passou, $FAIL falhou ──"
[ "$FAIL" -eq 0 ]
