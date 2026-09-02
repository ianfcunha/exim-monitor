#!/usr/bin/env bash
# =============================================================================
# Mail IQ — atualização para uma versão específica, com verificação de
# saúde e rollback automático da imagem.
#
#   ./upgrade.sh 1.1.0          # atualiza para a 1.1.0
#   ./upgrade.sh v1.1.0         # o "v" é opcional
#
# O que faz, em ordem:
#   1. backup.sh (se presente) — dump do banco + .env, antes de tudo
#   2. troca MAILIQ_VERSION no .env (guarda .env.bak-<atual> p/ rollback)
#   3. docker compose pull + up -d
#   4. espera /api/version reportar a versão alvo e /api/health = ok
#   5. se algo falhar: volta o .env, puxa e sobe a versão anterior
#
# Rollback cobre a IMAGEM. Se a versão nova rodou migrations no banco
# antes de falhar, o banco pode ter mudado de schema — nesse caso
# restaure o backup do passo 1 com ./restore.sh.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  ✓ $*${NC}"; }
info() { echo -e "${BLUE}  → $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠ $*${NC}"; }
err()  { echo -e "${RED}  ✗ $*${NC}"; exit 1; }

TARGET="${1:-}"
[[ -z "$TARGET" ]] && err "uso: ./upgrade.sh <versão>   (ex.: ./upgrade.sh 1.1.0)"
TARGET="${TARGET#v}"

[[ -f .env ]] || err ".env não encontrado — rode ./install.sh primeiro."

COMPOSE="docker compose"
docker compose version &>/dev/null 2>&1 || COMPOSE="docker-compose"

CURRENT="$(grep -E '^MAILIQ_VERSION=' .env | head -1 | cut -d= -f2- | tr -d '[:space:]')"
[[ -z "$CURRENT" ]] && err "MAILIQ_VERSION ausente no .env."
[[ "$CURRENT" == "$TARGET" ]] && { warn "Já está na versão $TARGET — nada a fazer."; exit 0; }

echo ""
info "Atualização: ${CURRENT}  →  ${TARGET}"
echo ""

# ── 1. Backup ────────────────────────────────────────────────────────────────
if [[ -x ./backup.sh ]]; then
  info "Backup pré-atualização..."
  ./backup.sh || err "Backup falhou — atualização abortada."
else
  warn "backup.sh não está neste diretório — a atualização seguirá SEM backup."
  read -rp "  Continuar mesmo assim? [s/N]: " a
  [[ "${a:-n}" =~ ^[Ss]$ ]] || exit 1
fi

# ── 2. Aponta o .env para a nova tag ─────────────────────────────────────────
ENV_BAK=".env.bak-${CURRENT}"
cp .env "$ENV_BAK"
sed -i.tmp -E "s|^MAILIQ_VERSION=.*|MAILIQ_VERSION=${TARGET}|" .env && rm -f .env.tmp
ok ".env atualizado (cópia anterior: ${ENV_BAK})"

DID_ROLLBACK=0
rollback() {
  [[ "$DID_ROLLBACK" -eq 1 ]] && err "Rollback também falhou. Intervenção manual necessária."
  DID_ROLLBACK=1
  echo ""
  warn "Revertendo para ${CURRENT}..."
  cp "$ENV_BAK" .env
  $COMPOSE pull   || true
  $COMPOSE up -d  || true
  echo ""
  err "Atualização revertida para ${CURRENT}. Se a ${TARGET} chegou a rodar
     migrations, o banco pode ter mudado — restaure o backup do passo 1
     com ./restore.sh. Logs: ${COMPOSE} logs backend"
}

# ── 3. Puxa e sobe ──────────────────────────────────────────────────────────
info "Puxando imagens ${TARGET}..."
if ! $COMPOSE pull; then
  warn "Falha ao puxar. As imagens são privadas — o daemon está autenticado no ghcr.io?"
  warn "  docker login ghcr.io -u <seu-usuário-github>   (token read-only — ver docs/instalar.md)"
  rollback
fi

info "Subindo containers..."
$COMPOSE up -d || rollback

# ── 4. Verificação de saúde ─────────────────────────────────────────────────
info "Aguardando o backend reportar a versão ${TARGET}..."
HEALTHY=0
for _ in $(seq 1 40); do
  V="$(curl -sf http://localhost:8000/api/version 2>/dev/null | tr -d '[:space:]' || true)"
  if [[ -n "$V" ]] && echo "$V" | grep -q "\"version\":\"${TARGET}\""; then
    HEALTHY=1; break
  fi
  sleep 3
done
[[ "$HEALTHY" -eq 1 ]] || { warn "O backend não reportou ${TARGET} a tempo."; rollback; }

curl -sf http://localhost:8000/api/health 2>/dev/null | tr -d '[:space:]' | grep -q '"status":"ok"' \
  || { warn "/api/health não está OK."; rollback; }

echo ""
ok "Mail IQ atualizado para ${TARGET}."
info "Confira o CHANGELOG e o painel. Backup do .env anterior: ${ENV_BAK}"
info "(pode remover quando tiver certeza de que a ${TARGET} está estável)."
