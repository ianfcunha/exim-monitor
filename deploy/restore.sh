#!/usr/bin/env bash
# =============================================================================
# Mail IQ — restaura um backup (dump do banco + .env).
#
#   ./restore.sh backups/AAAAMMDD-HHMMSS.mailiq-backup.tar.gz
#
# ANTES de tocar em qualquer coisa, valida que a SSH_ENCRYPTION_KEY do
# .env do backup realmente decifra os segredos SSH do dump — restaurar um
# dump com a chave errada deixaria todos os servidores indecifráveis.
#
# Fluxo: valida a chave → snapshot do estado atual → para o backend →
# recria o banco → aplica o dump → restaura o .env → sobe tudo.
# Preserva o volume do Caddy (não re-emite o certificado).
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")" || exit 1

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  ✓ $*${NC}"; }
info() { echo -e "${BLUE}  → $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠ $*${NC}"; }
err()  { echo -e "${RED}  ✗ $*${NC}"; exit 1; }

ARCHIVE="${1:-}"
[[ -f "$ARCHIVE" ]] || err "uso: ./restore.sh <arquivo.mailiq-backup.tar.gz>"
[[ -f .env ]] || err ".env atual não encontrado — o restore precisa dele para a config do compose."

COMPOSE="docker compose"
docker compose version &>/dev/null 2>&1 || COMPOSE="docker-compose"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
tar -xzf "$ARCHIVE" -C "$STAGE"
[[ -f "$STAGE/db.sql" && -f "$STAGE/env" ]] || err "isto não parece um backup do Mail IQ (falta db.sql ou env)."

echo ""
[[ -f "$STAGE/MANIFEST" ]] && { info "Backup:"; sed 's/^/     /' "$STAGE/MANIFEST"; echo ""; }

# ── 1. Validação da chave Fernet ────────────────────────────────────────────
BACKUP_KEY="$(grep -E '^SSH_ENCRYPTION_KEY=' "$STAGE/env" | head -1 | cut -d= -f2-)"
[[ -n "$BACKUP_KEY" ]] || err "o .env do backup não tem SSH_ENCRYPTION_KEY — impossível validar."

IMG="$(grep -E '^MAILIQ_REGISTRY=' .env | cut -d= -f2- | tr -d '[:space:]')/exim-monitor-backend:$(grep -E '^MAILIQ_VERSION=' .env | cut -d= -f2- | tr -d '[:space:]')"
docker image inspect "$IMG" &>/dev/null || { info "Puxando $IMG para a validação..."; docker pull "$IMG" >/dev/null || err "não consegui a imagem do backend para validar a chave."; }

info "Validando a chave Fernet do backup contra os segredos do dump..."
set +e
docker run --rm -e FERNET_KEY="$BACKUP_KEY" \
  -v "$STAGE/db.sql:/dump.sql:ro" \
  -v "$PWD/check-key.py:/check-key.py:ro" \
  "$IMG" python /check-key.py /dump.sql
RC=$?
set -e
case "$RC" in
  0) ok "A chave do backup confere com os segredos do dump." ;;
  2) warn "O dump não tem segredos SSH cifrados (nenhum servidor cadastrado) — nada a validar."
     read -rp "  Continuar mesmo assim? [s/N]: " a
     [[ "${a:-n}" =~ ^[Ss]$ ]] || exit 1 ;;
  3) err "A SSH_ENCRYPTION_KEY do backup NÃO decifra os segredos do dump.
     Restaurar assim deixaria todos os servidores indecifráveis. Abortado." ;;
  *) err "Falha ao validar a chave (código $RC)." ;;
esac

# ── 2. Confirmação ─────────────────────────────────────────────────────────
echo ""
warn "Isto vai PARAR o painel, APAGAR o banco atual e restaurar o backup."
read -rp "  Digite 'restaurar' para confirmar: " CONFIRM
[[ "$CONFIRM" == "restaurar" ]] || { warn "Cancelado."; exit 0; }

# ── 3. Snapshot do estado atual (rede de segurança) ───────────────────────
if [[ -x ./backup.sh ]] && $COMPOSE ps postgres 2>/dev/null | grep -q .; then
  info "Snapshot do estado atual antes de restaurar..."
  ./backup.sh || warn "não consegui o snapshot — seguindo."
fi

# ── 4. Recria o banco e aplica o dump ─────────────────────────────────────
info "Subindo só o postgres..."
$COMPOSE up -d postgres
for _ in $(seq 1 30); do
  $COMPOSE exec -T postgres pg_isready -U exim -d exim_monitor &>/dev/null && break
  sleep 1
done

info "Parando o backend..."
$COMPOSE stop backend 2>/dev/null || true

info "Recriando o banco exim_monitor..."
$COMPOSE exec -T postgres psql -U exim -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS exim_monitor WITH (FORCE);" \
  -c "CREATE DATABASE exim_monitor OWNER exim;"

info "Aplicando o dump..."
$COMPOSE exec -T postgres psql -U exim -d exim_monitor -v ON_ERROR_STOP=1 -q < "$STAGE/db.sql"

# ── 5. Injeta a SSH_ENCRYPTION_KEY do backup no .env atual ───────────────
# Só a chave Fernet precisa vir do backup (é o que casa com o dump).
# POSTGRES_PASSWORD, DOMAIN, MAILIQ_VERSION/REGISTRY são desta máquina —
# sobrescrevê-los com os do backup quebraria o acesso ao volume do
# Postgres / o certificado. O .env completo do backup fica salvo ao lado,
# para referência.
TS_NOW="$(date +%Y%m%d-%H%M%S)"
cp .env ".env.pre-restore-${TS_NOW}"
cp "$STAGE/env" ".env.from-backup-${TS_NOW}"; chmod 600 ".env.from-backup-${TS_NOW}"
if grep -qE '^SSH_ENCRYPTION_KEY=' .env; then
  sed -i.tmp -E "s|^SSH_ENCRYPTION_KEY=.*|SSH_ENCRYPTION_KEY=${BACKUP_KEY}|" .env && rm -f .env.tmp
else
  printf '\nSSH_ENCRYPTION_KEY=%s\n' "$BACKUP_KEY" >> .env
fi
chmod 600 .env
ok "SSH_ENCRYPTION_KEY do backup aplicada ao .env (cópia anterior: .env.pre-restore-${TS_NOW})."

# ── 6. Sobe tudo ─────────────────────────────────────────────────────────
info "Subindo a stack..."
$COMPOSE up -d

info "Aguardando o backend..."
HEALTHY=0
for _ in $(seq 1 40); do
  curl -sf http://localhost:8000/api/health &>/dev/null && { HEALTHY=1; break; }
  sleep 3
done
[[ "$HEALTHY" -eq 1 ]] && ok "Backend no ar." || warn "Backend demorou — verifique: $COMPOSE logs backend"

echo ""
ok "Restauração concluída."
info "Confira o painel: servidores, incidentes e o teste de conexão SSH."
