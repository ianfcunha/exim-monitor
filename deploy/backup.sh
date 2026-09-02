#!/usr/bin/env bash
# =============================================================================
# Mail IQ — backup: dump do banco + .env, num único tarball.
#
#   ./backup.sh            → backups/AAAAMMDD-HHMMSS.mailiq-backup.tar.gz
#
# O tarball contém a SSH_ENCRYPTION_KEY (dentro do .env) — a chave que
# decifra as credenciais SSH de todos os servidores. Sem ela, o dump do
# banco é inútil; com ela, quem tiver o arquivo tem tudo. Guarde os
# backups FORA deste servidor. chmod 600 é aplicado.
#
# Não-interativo de propósito — o upgrade.sh chama este script.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")" || exit 1

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  ✓ $*${NC}"; }
info() { echo -e "${BLUE}  → $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠ $*${NC}"; }
err()  { echo -e "${RED}  ✗ $*${NC}"; exit 1; }

[[ -f .env ]] || err ".env não encontrado — nada para fazer backup."

COMPOSE="docker compose"
docker compose version &>/dev/null 2>&1 || COMPOSE="docker-compose"

$COMPOSE ps postgres 2>/dev/null | grep -q . || err "container do postgres não está de pé (rode: $COMPOSE up -d)."

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

info "Dump do banco..."
$COMPOSE exec -T postgres pg_dump -U exim --no-owner --no-privileges exim_monitor > "$STAGE/db.sql"
[[ -s "$STAGE/db.sql" ]] || err "o dump saiu vazio — abortado."
grep -q "PostgreSQL database dump" "$STAGE/db.sql" || err "o dump não parece válido — abortado."

cp .env "$STAGE/env"

VERSION="$(grep -E '^MAILIQ_VERSION=' .env | cut -d= -f2- | tr -d '[:space:]')"
SCHEMA="$(curl -sf http://localhost:8000/api/version 2>/dev/null | tr -d '[:space:]' | grep -oE '"schema_version":"[^"]+"' | cut -d'"' -f4 || true)"

cat > "$STAGE/MANIFEST" <<EOF
mailiq-backup
created_at=$(date -Iseconds)
mailiq_version=${VERSION:-desconhecida}
schema_version=${SCHEMA:-desconhecida}
db_bytes=$(wc -c < "$STAGE/db.sql")
host=$(hostname)
EOF

mkdir -p backups
TS="$(date +%Y%m%d-%H%M%S)"
OUT="backups/${TS}.mailiq-backup.tar.gz"
tar -czf "$OUT" -C "$STAGE" db.sql env MANIFEST
chmod 600 "$OUT"

ok "Backup: ${OUT}  ($(du -h "$OUT" | cut -f1))"
warn "Contém a chave Fernet + o dump do banco. Copie para fora deste servidor."
