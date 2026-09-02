#!/usr/bin/env bash
# =============================================================================
# Mail IQ — instalação do PAINEL a partir de imagens versionadas (ghcr.io).
#
# Este script instala SÓ o painel (Docker Compose + banco + credenciais).
# Não toca em nenhum servidor Exim monitorado. Para conectar um servidor,
# depois que o painel estiver no ar: Servidores → Adicionar, e rode o
# mailiq-bootstrap.sh NO SERVIDOR MONITORADO (ver docs/instalar.md).
#
# Rode de novo com segurança: reaproveita os segredos do .env existente.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  ✓ $*${NC}"; }
info() { echo -e "${BLUE}  → $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠ $*${NC}"; }
err()  { echo -e "${RED}  ✗ $*${NC}"; exit 1; }
ask()  { echo -e "${BOLD}$*${NC}"; }

echo -e "\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  Mail IQ — instalação do painel${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

# ── Dependências ────────────────────────────────────────────────────────────
command -v docker &>/dev/null || err "Docker não encontrado. Instale: https://docs.docker.com/get-docker/"
COMPOSE="docker compose"
if ! docker compose version &>/dev/null 2>&1; then
  command -v docker-compose &>/dev/null && COMPOSE="docker-compose" \
    || err "Docker Compose não encontrado (plugin 'docker compose' ou 'docker-compose')."
fi
command -v openssl &>/dev/null || err "openssl não encontrado (necessário para gerar segredos)."
command -v curl    &>/dev/null || err "curl não encontrado."
ok "Docker, Compose, openssl e curl disponíveis"

# ── Registry privado (ghcr.io) ─────────────────────────────────────────────
echo ""
ask "1. Acesso às imagens (ghcr.io — privado)"
if grep -q 'ghcr\.io' "${HOME}/.docker/config.json" 2>/dev/null; then
  ok "Login no ghcr.io já presente em ~/.docker/config.json"
  ask "   Pressione Enter para reaproveitar, ou informe outras credenciais."
  read -rp "   Usuário GitHub (Enter p/ manter): " GH_USER
else
  ask "   Informe as credenciais read-only do registry (ver docs/instalar.md)."
  read -rp "   Usuário GitHub: " GH_USER
fi
if [[ -n "${GH_USER:-}" ]]; then
  read -rsp "   Token (read:packages): " GH_TOKEN; echo
  echo "$GH_TOKEN" | docker login ghcr.io -u "$GH_USER" --password-stdin \
    || err "Falha no login do ghcr.io."
  ok "Autenticado no ghcr.io"
fi

# ── Reaproveita segredos de instalação anterior ───────────────────────────
_get() { [[ -f .env ]] && grep -E "^$1=" .env | head -1 | cut -d= -f2- || true; }
OLD_PG="$(_get POSTGRES_PASSWORD)"
OLD_JWT="$(_get JWT_SECRET)"
OLD_SSHK="$(_get SSH_ENCRYPTION_KEY)"
OLD_VERSION="$(_get MAILIQ_VERSION)"
if [[ -n "$OLD_PG" || -n "$OLD_SSHK" ]]; then
  warn "Instalação anterior detectada — reaproveitando senha do banco, chave"
  warn "de cifra SSH e JWT do .env existente (trocá-los quebraria o que já roda)."
fi

# ── Perguntas ─────────────────────────────────────────────────────────────
DEFAULT_VERSION="$(grep -E '^MAILIQ_VERSION=' .env.example | cut -d= -f2-)"
DEFAULT_REGISTRY="$(grep -E '^MAILIQ_REGISTRY=' .env.example | cut -d= -f2-)"

echo ""
ask "2. Versão a instalar (default: ${OLD_VERSION:-$DEFAULT_VERSION})"
read -rp "   Versão: " VERSION
VERSION="${VERSION:-${OLD_VERSION:-$DEFAULT_VERSION}}"; VERSION="${VERSION#v}"

echo ""
ask "3. Domínio do painel (registro A já apontando para este servidor)"
ask "   O Caddy emite o certificado TLS automaticamente na 1ª requisição."
read -rp "   Domínio: " DOMAIN
[[ -z "$DOMAIN" ]] && err "O domínio é obrigatório (o Caddy precisa dele para o certificado)."

echo ""
ask "4. Credenciais do painel"
read -rp  "   Usuário admin (default: admin): " ADMIN_USER
ADMIN_USER="${ADMIN_USER:-admin}"
read -rp  "   E-mail do admin: " ADMIN_EMAIL
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@${DOMAIN}}"
while true; do
  read -rsp "   Senha admin: " ADMIN_PASS; echo
  read -rsp "   Confirme: "    ADMIN_PASS2; echo
  [[ -n "$ADMIN_PASS" && "$ADMIN_PASS" == "$ADMIN_PASS2" ]] && break
  warn "Senhas vazias ou diferentes. De novo."
done

PG_PASS="${OLD_PG:-$(openssl rand -base64 24 | tr -d '=+/' | head -c 24)}"
JWT_SECRET="${OLD_JWT:-$(openssl rand -hex 32)}"
SSH_KEY="${OLD_SSHK:-$(openssl rand -base64 32 | tr '+/' '-_')}"

# ── Escreve .env ──────────────────────────────────────────────────────────
cat > .env <<ENV
# Mail IQ — gerado pelo install.sh em $(date)
MAILIQ_VERSION=${VERSION}
MAILIQ_REGISTRY=${DEFAULT_REGISTRY}

DOMAIN=${DOMAIN}
POSTGRES_PASSWORD=${PG_PASS}

ENVIRONMENT=production
ADMIN_USERNAME=${ADMIN_USER}
ADMIN_PASSWORD=${ADMIN_PASS}
ADMIN_EMAIL=${ADMIN_EMAIL}

JWT_SECRET=${JWT_SECRET}
SSH_ENCRYPTION_KEY=${SSH_KEY}
JWT_EXPIRE_MINUTES=480

CORS_ORIGINS=["https://${DOMAIN}"]

QUICK_INTERVAL=30
FULL_INTERVAL=300
ENV
chmod 600 .env
ok ".env criado (chmod 600 — contém a chave-mestra de cifra SSH)"

# ── Sobe ─────────────────────────────────────────────────────────────────
echo ""
info "Puxando imagens ${VERSION} e subindo..."
$COMPOSE pull
$COMPOSE up -d --remove-orphans

info "Aguardando o backend..."
for i in $(seq 1 40); do
  curl -sf http://localhost:8000/api/health &>/dev/null && { ok "Backend no ar"; break; }
  sleep 3
  [[ $i -eq 40 ]] && warn "Demorou mais que o esperado — verifique: ${COMPOSE} logs backend"
done

echo ""
echo -e "${GREEN}${BOLD}  Painel instalado.${NC}"
echo -e "  Dashboard:  ${BLUE}https://${DOMAIN}${NC}"
echo -e "  API docs:   ${BLUE}https://${DOMAIN}/api/docs${NC}"
echo -e "  Versão:     ${BOLD}${VERSION}${NC}   (confira em https://${DOMAIN}/api/version)"
echo ""
echo -e "  Atualizar:  ${YELLOW}./upgrade.sh <versão>${NC}"
echo -e "  Backup:     ${YELLOW}./backup.sh${NC}"
echo -e "  Logs:       ${YELLOW}${COMPOSE} logs -f backend${NC}"
echo ""
echo -e "  Próximo passo — conectar um servidor Exim: entre no painel,"
echo -e "  Servidores → Adicionar, e siga o mailiq-bootstrap.sh. Ver docs/instalar.md."
echo ""
