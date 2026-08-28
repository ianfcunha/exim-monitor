#!/usr/bin/env bash
# =============================================================================
# Mail IQ — Instalacao do PAINEL em 5 minutos
# Suporta: instalacao padrao, HTTPS (Caddy), e ambientes gerenciados
# (Cloudez, Configr, cPanel, Plesk) com nginx reverse proxy
#
# T7 (Sessao 1, pos-auditoria): este script SO instala o painel (docker
# compose, banco, credenciais admin). Ele nao mexe em nenhum servidor
# EXIM monitorado, nao gera nem instala chave SSH em authorized_keys de
# ninguem, e nao pede senha de root de servidor nenhum alem deste onde o
# painel vai rodar.
#
# Para conectar um servidor EXIM (o seu ou de um cliente): depois que o
# painel estiver no ar, va em Servidores -> Adicionar e siga o fluxo de
# mailiq-bootstrap.sh (rodado NO SERVIDOR MONITORADO, nao aqui) — ver
# docs/seguranca.md. Esse e o caminho recomendado: usuario dedicado
# mailiq, sem root, com sudoers minimo e auditavel antes de instalar.
# =============================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; NC='\033[0m'

ok()   { echo -e "${GREEN}  ✓ $*${NC}"; }
info() { echo -e "${BLUE}  → $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠ $*${NC}"; }
err()  { echo -e "${RED}  ✗ $*${NC}"; exit 1; }
ask()  { echo -e "${BOLD}$*${NC}"; }

echo -e "\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  Mail IQ — Instalacao do painel${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
info "Este script instala SO o painel (docker compose + banco)."
info "Para conectar um servidor EXIM, use mailiq-bootstrap.sh depois — ver docs/seguranca.md."

# ── Verifica dependencias ──────────────────────────────────────────────────
info "Verificando dependencias..."
if ! command -v docker &>/dev/null; then
  warn "Docker nao encontrado."
  read -rp "  Instalar agora via get.docker.com (script oficial)? [S/n]: " DK_ANSWER
  DK_ANSWER="${DK_ANSWER:-s}"
  if [[ "$DK_ANSWER" =~ ^[Ss]$ ]]; then
    curl -fsSL https://get.docker.com | sh || err "Instalacao do Docker falhou — instale manualmente: https://docs.docker.com/get-docker/"
    systemctl enable --now docker 2>/dev/null || true
    ok "Docker instalado"
  else
    err "Docker e necessario. Instale em https://docs.docker.com/get-docker/ e rode este script de novo."
  fi
fi
command -v git     &>/dev/null || err "Git nao encontrado. Instale com: apt install git"
COMPOSE_CMD=""
if docker compose version &>/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose &>/dev/null; then
  COMPOSE_CMD="docker-compose"
else
  err "Docker Compose nao encontrado. Instale o Docker Desktop ou o plugin Compose."
fi
ok "Docker e Compose disponiveis"

# ── Variaveis de ambiente (defaults) ──────────────────────────────────────
USE_SSL="n"
REVERSE_PROXY="n"
NGINX_CONFD=""

# ── Coleta informacoes ─────────────────────────────────────────────────────
echo ""
ask "1. Dominio do dashboard (ex: monitor.seudominio.com)"
ask "   Deixe em branco para usar apenas HTTP local (localhost)"
read -rp "   Dominio: " DOMAIN
DOMAIN="${DOMAIN:-localhost}"

if [[ "$DOMAIN" != "localhost" ]]; then
  echo ""
  ask "1b. Este servidor ja tem nginx ou Apache rodando na porta 80?"
  ask "    (Cloudez, Configr, cPanel, Plesk ou qualquer painel gerenciado)"
  read -rp "    Porta 80 ocupada? [s/N]: " RP_ANSWER
  RP_ANSWER="${RP_ANSWER:-n}"

  if [[ "$RP_ANSWER" =~ ^[Ss]$ ]]; then
    REVERSE_PROXY="y"

    # Nginx conf.d do dominio (padrao Cloudez/Configr: /srv/<dominio>/etc/nginx/conf.d)
    if [[ -d "/srv/${DOMAIN}/etc/nginx/conf.d" ]]; then
      NGINX_CONFD="/srv/${DOMAIN}/etc/nginx/conf.d"
    else
      # Tenta encontrar via symlink (Cloudez as vezes usa um dir base diferente)
      for dir in /srv/*/etc/nginx/conf.d; do
        [[ -d "$dir" ]] && { NGINX_CONFD="$dir"; break; }
      done
    fi

    if [[ -n "$NGINX_CONFD" ]]; then
      ok "Nginx conf.d detectado: ${BOLD}${NGINX_CONFD}${NC}"
    else
      warn "Nginx conf.d nao encontrado (configure manualmente apos a instalacao)"
    fi

  else
    echo ""
    ask "1c. Habilitar HTTPS com certificado automatico? (via Caddy — recomendado)"
    ask "    Requer portas 80 e 443 livres e o DNS de $DOMAIN ja apontando aqui."
    ask "    Sem isto o painel so escuta em 127.0.0.1 (nao acessivel de fora)."
    read -rp "    Habilitar HTTPS? [S/n]: " SSL_ANSWER
    SSL_ANSWER="${SSL_ANSWER:-s}"
    if [[ "$SSL_ANSWER" =~ ^[Ss]$ ]]; then
      USE_SSL="y"
      ok "HTTPS habilitado — Caddy gerenciara o certificado automaticamente"
    else
      warn "HTTPS desabilitado — o painel ficara SO em http://127.0.0.1:5173"
      warn "deste servidor. Para acesso externo, configure um reverse proxy"
      warn "para a porta 5173 depois, ou rode o script de novo com HTTPS."
    fi
  fi
fi

# ── Credenciais do painel ─────────────────────────────────────────────────
echo ""
ask "2. Credenciais do painel web"
read -rp "   Usuario admin (default: admin): " ADMIN_USER
ADMIN_USER="${ADMIN_USER:-admin}"
while true; do
  read -rsp "   Senha admin: " ADMIN_PASS; echo
  read -rsp "   Confirme a senha: " ADMIN_PASS2; echo
  [[ "$ADMIN_PASS" == "$ADMIN_PASS2" ]] && break
  warn "Senhas nao conferem. Tente novamente."
done

# ── Senha do banco ────────────────────────────────────────────────────────
echo ""
ask "3. Senha do banco de dados PostgreSQL"
read -rsp "   Senha PostgreSQL (default: gerada automaticamente): " PG_PASS; echo
if [[ -z "$PG_PASS" ]]; then
  PG_PASS=$(openssl rand -base64 24 | tr -d '=+/' | head -c 24)
  info "Senha gerada: $PG_PASS (salva no .env)"
fi

JWT_SECRET=$(openssl rand -hex 32)
SSH_ENCRYPTION_KEY=$(openssl rand -base64 32 | tr '+/' '-_')

# ── Resumo e confirmacao ───────────────────────────────────────────────────
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  Resumo — o que sera feito${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "  Dominio:        ${BOLD}$DOMAIN${NC}"
if [[ "$USE_SSL" == "y" ]]; then
  echo -e "  Acesso:         ${BOLD}HTTPS via Caddy${NC}"
elif [[ "$REVERSE_PROXY" == "y" ]]; then
  echo -e "  Acesso:         ${BOLD}Reverse proxy nginx (${NGINX_CONFD:-detectar no deploy})${NC}"
else
  echo -e "  Acesso:         ${BOLD}HTTP porta 5173${NC}"
fi
echo -e "  Admin:          ${BOLD}$ADMIN_USER${NC}"
echo ""
echo -e "  Nenhum servidor EXIM sera tocado por este script."
echo ""
read -rp "  Confirmar instalacao? [S/n]: " CONFIRM
CONFIRM="${CONFIRM:-s}"
[[ "$CONFIRM" =~ ^[Nn]$ ]] && { warn "Instalacao cancelada."; exit 0; }

# ── Clona ou atualiza repositorio ─────────────────────────────────────────
echo ""
info "Preparando arquivos..."

REPO_URL="${REPO_URL:-https://github.com/ianfcunha/exim-monitor.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
INSTALL_DIR="$HOME/exim-monitor"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || echo "")"
if [[ -f "$SCRIPT_DIR/docker-compose.yml" ]]; then
  INSTALL_DIR="$SCRIPT_DIR"
  info "Usando diretorio local: $INSTALL_DIR"
elif [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Atualizando repositorio existente em $INSTALL_DIR..."
  git -C "$INSTALL_DIR" pull --ff-only || true
else
  info "Clonando repositorio (branch $REPO_BRANCH) em $INSTALL_DIR..."
  git clone -b "$REPO_BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

cd "$INSTALL_DIR"

# ── Gera backend/.env ─────────────────────────────────────────────────────
# Sem SSH_HOST/SSH_USER/SSH_KEY_PATH aqui de proposito — o painel nao
# assume mais um unico servidor EXIM "padrao" configurado por .env.
# Servidores sao cadastrados pela UI depois que o painel estiver de pe
# (Servidores -> Adicionar), cada um com sua propria credencial.
mkdir -p backend
cat > backend/.env << ENV
# Mail IQ — Configuracoes geradas pelo install.sh em $(date)
ENVIRONMENT=production

ADMIN_USERNAME=$ADMIN_USER
ADMIN_PASSWORD=$ADMIN_PASS

JWT_SECRET=$JWT_SECRET
SSH_ENCRYPTION_KEY=$SSH_ENCRYPTION_KEY
JWT_EXPIRE_MINUTES=480

DATABASE_URL=postgresql://exim:${PG_PASS}@postgres:5432/exim_monitor

CORS_ORIGINS=["$([ "$USE_SSL" = "y" ] && echo "https" || echo "http")://$DOMAIN","$([ "$REVERSE_PROXY" = "y" ] && echo "http://$DOMAIN" || echo "http://localhost:5173")"]

QUICK_INTERVAL=30
FULL_INTERVAL=300
ENV
ok "backend/.env criado"

# ── Gera .env raiz ────────────────────────────────────────────────────────
cat > .env << ENV
DOMAIN=$DOMAIN
POSTGRES_PASSWORD=$PG_PASS
ENV
ok ".env raiz criado"

# ── Sobe os containers ────────────────────────────────────────────────────
echo ""
info "Construindo e subindo containers (pode demorar alguns minutos na primeira vez)..."

if [[ "$USE_SSL" == "y" ]]; then
  $COMPOSE_CMD -f docker-compose.prod.yml up -d --build
else
  $COMPOSE_CMD up -d --build
fi

ok "Containers iniciados"

# ── Configura nginx reverse proxy (Cloudez/Configr) ──────────────────────
if [[ "$REVERSE_PROXY" == "y" ]]; then
  echo ""
  info "Configurando nginx reverse proxy para $DOMAIN..."

  # Ultima tentativa de detectar conf.d se ainda nao encontrado
  if [[ -z "$NGINX_CONFD" ]]; then
    for dir in /srv/*/etc/nginx/conf.d; do
      [[ -d "$dir" ]] && { NGINX_CONFD="$dir"; break; }
    done
  fi

  if [[ -n "$NGINX_CONFD" ]]; then
    cat > "$NGINX_CONFD/proxy.conf" << 'NGINX'
location ~* ^/.*$ {
    proxy_pass         http://localhost:5173;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   Upgrade           $http_upgrade;
    proxy_set_header   Connection        "upgrade";
    proxy_read_timeout  60s;
    proxy_send_timeout  60s;
}
NGINX
    ok "proxy.conf criado em $NGINX_CONFD"

    # Tenta recarregar nginx (varios metodos por compatibilidade)
    if /usr/local/bin/nginx -s reload 2>/dev/null; then
      ok "nginx recarregado (/usr/local/bin/nginx)"
    elif nginx -s reload 2>/dev/null; then
      ok "nginx recarregado (nginx)"
    elif systemctl reload nginx 2>/dev/null; then
      ok "nginx recarregado (systemctl)"
    else
      warn "Recarregue nginx manualmente: /usr/local/bin/nginx -s reload"
    fi
  else
    warn "Nao foi possivel detectar o diretorio conf.d do nginx para $DOMAIN"
    warn "Crie manualmente: /srv/$DOMAIN/etc/nginx/conf.d/proxy.conf"
    warn "Template disponivel em: $INSTALL_DIR/nginx-vhost.conf"
  fi

  # SSL opcional via certbot
  echo ""
  ask "Deseja habilitar HTTPS com Let's Encrypt agora? (certbot deve estar instalado)"
  read -rp "Habilitar SSL via certbot? [s/N]: " CERT_ANSWER
  CERT_ANSWER="${CERT_ANSWER:-n}"
  if [[ "$CERT_ANSWER" =~ ^[Ss]$ ]]; then
    if command -v certbot &>/dev/null; then
      certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@$DOMAIN" && \
        USE_SSL="y" || warn "Certbot falhou. Verifique se o DNS ja aponta para este servidor."
    else
      warn "certbot nao encontrado. Instale: apt install certbot python3-certbot-nginx"
      warn "Depois rode: certbot --nginx -d $DOMAIN"
    fi
  fi
fi

# ── Aguarda backend ficar saudavel ────────────────────────────────────────
info "Aguardando o backend inicializar..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:8000/api/health &>/dev/null; then
    ok "Backend respondendo"
    break
  fi
  sleep 2
  if [[ $i -eq 30 ]]; then
    warn "Backend demorou mais que o esperado. Verifique: $COMPOSE_CMD logs backend"
  fi
done

# ── Resumo final ──────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  Painel instalado!${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [[ "$USE_SSL" == "y" ]]; then
  echo -e "  Dashboard:  ${BLUE}https://$DOMAIN${NC}"
  echo -e "  API Docs:   ${BLUE}https://$DOMAIN/api/docs${NC}"
elif [[ "$REVERSE_PROXY" == "y" ]]; then
  echo -e "  Dashboard:  ${BLUE}http://$DOMAIN${NC}"
  echo -e "  API Docs:   ${BLUE}http://$DOMAIN/api/docs${NC}"
  echo -e "  ${YELLOW}(Para HTTPS: certbot --nginx -d $DOMAIN)${NC}"
else
  # localhost, ou dominio sem SSL/proxy: as portas so escutam em 127.0.0.1
  echo -e "  Dashboard:  ${BLUE}http://localhost:5173${NC} ${YELLOW}(so neste servidor)${NC}"
  echo -e "  API Docs:   ${BLUE}http://localhost:8000/api/docs${NC}"
  if [[ "$DOMAIN" != "localhost" ]]; then
    echo -e "  ${YELLOW}Para acesso externo por $DOMAIN: configure um reverse proxy${NC}"
    echo -e "  ${YELLOW}para 127.0.0.1:5173, ou rode este script de novo com HTTPS.${NC}"
  fi
fi

echo ""
echo -e "  Usuario:    ${BOLD}$ADMIN_USER${NC}"
echo -e "  Senha:      ${BOLD}(a que voce definiu)${NC}"
echo ""
echo -e "  Logs:       ${YELLOW}$COMPOSE_CMD logs -f backend${NC}"
echo -e "  Parar:      ${YELLOW}$COMPOSE_CMD down${NC}"
echo -e "  Atualizar:  ${YELLOW}git pull && $COMPOSE_CMD up -d --build${NC}"
echo ""
echo -e "${BOLD}  Proximo passo — conectar um servidor EXIM:${NC}"
echo -e "  1. Entre no painel e va em Servidores → Adicionar"
echo -e "  2. Clique em \"Gerar chave\" — o painel cria um par de chaves e"
echo -e "     mostra a chave publica"
echo -e "  3. No servidor EXIM (nao aqui), rode:"
echo -e "     ${YELLOW}bash mailiq-bootstrap.sh --pubkey 'ssh-ed25519 AAAA...'${NC}"
echo -e "     (leia o script inteiro antes — ele so precisa da SUA senha de"
echo -e "     root local naquele servidor, uma vez, nunca do painel)"
echo -e "  4. Volte aqui e clique em \"Testar conexao\""
echo -e "  Detalhes e o sudoers de referência: ${YELLOW}docs/seguranca.md${NC}"
echo ""

if [[ "$USE_SSL" == "y" ]]; then
  echo -e "${YELLOW}  Certifique-se de que o DNS aponta para este servidor${NC}"
  echo ""
fi
