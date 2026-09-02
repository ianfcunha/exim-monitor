#!/usr/bin/env bash
# =============================================================================
# Subconjunto da suíte que roda sem o stack de dev e sem um Exim de verdade
# entregando mensagem — é o que o CI executa em todo push/PR
# (.github/workflows/tests.yml).
#
# Os demais testes em tests/*.sh precisam de docker compose de pé
# (credenciais em backend/.env) ou de Exim/iptables/SSH reais — ver
# tests/README.md. test_migrations.sh tem workflow próprio (Migrations).
# =============================================================================
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

CI_SAFE=(
  test_detectors.sh          # detectors.py puro (só stdlib)
  test_log_recognition.sh    # sourcing de diag-exim.sh + fixtures, sem Exim
  test_check_sanity.sh       # sourcing de diag-exim.sh — checagens DNSBL/cert tolerantes a falta de rede
)

fail=0
for t in "${CI_SAFE[@]}"; do
  echo ""
  echo "═══ tests/$t ═══"
  if bash "tests/$t"; then
    echo "  ✓ $t"
  else
    echo "  ✗ $t (exit $?)"
    fail=1
  fi
done

echo ""
[[ "$fail" -eq 0 ]] && echo "run-ci: tudo verde" || echo "run-ci: houve falha"
exit "$fail"
