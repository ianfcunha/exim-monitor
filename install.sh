#!/usr/bin/env bash
# =============================================================================
# EXIM Monitor — Script de instalacao em 5 minutos
# Suporta: instalacao padrao, HTTPS (Caddy), e ambientes gerenciados
# (Cloudez, Configr, cPanel, Plesk) com nginx reverse proxy
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
echo -e "${BOLD}  EXIM Monitor — Instalacao${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

# ── Verifica dependencias ──────────────────────────────────────────────────
info "Verificando dependencias..."
command -v docker  &>/dev/null || err "Docker nao encontrado. Instale em https://docs.docker.com/get-docker/"
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
DETECTED_SSH_PORT="22"
DOCKER_BRIDGE="172.17.0.1"
FIREWALL_SVC=""
FIREWALL_CUSTOM=""
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

    # ── Analisa ambiente do servidor automaticamente ──────────────────────
    echo ""
    info "Analisando ambiente do servidor..."

    # Porta SSH
    DETECTED_SSH_PORT=$(ss -tlnp 2>/dev/null | grep sshd | grep -oP '(?<=:)\d+' | head -1)
    DETECTED_SSH_PORT="${DETECTED_SSH_PORT:-22}"

    # Docker bridge IP
    DOCKER_BRIDGE=$(ip addr show docker0 2>/dev/null | grep 'inet ' | awk '{print $2}' | cut -d/ -f1)
    DOCKER_BRIDGE="${DOCKER_BRIDGE:-172.17.0.1}"

    # Servico de firewall e arquivo de regras customizadas
    if systemctl is-active --quiet firewall.service 2>/dev/null; then
      FIREWALL_SVC="firewall.service"
      [[ -d "/etc/firewall.d" ]] && FIREWALL_CUSTOM="/etc/firewall.d/03_custom"
    elif systemctl is-active --quiet iptables 2>/dev/null; then
      FIREWALL_SVC="iptables"
      FIREWALL_CUSTOM="/etc/iptables/rules.v4"
    elif command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q "active"; then
      FIREWALL_SVC="ufw"
    fi

    # Nginx conf.d do dominio (padrao Cloudez/Configr: /srv/<dominio>/etc/nginx/conf.d)
    if [[ -d "/srv/${DOMAIN}/etc/nginx/conf.d" ]]; then
      NGINX_CONFD="/srv/${DOMAIN}/etc/nginx/conf.d"
    else
      # Tenta encontrar via symlink (Cloudez as vezes usa um dir base diferente)
      for dir in /srv/*/etc/nginx/conf.d; do
        [[ -d "$dir" ]] && { NGINX_CONFD="$dir"; break; }
      done
    fi

    ok "Ambiente detectado:"
    echo -e "     Porta SSH:      ${BOLD}${DETECTED_SSH_PORT}${NC}"
    echo -e "     Docker bridge:  ${BOLD}${DOCKER_BRIDGE}${NC}"
    echo -e "     Firewall:       ${BOLD}${FIREWALL_SVC:-nao detectado}${NC}"
    if [[ -n "$NGINX_CONFD" ]]; then
      echo -e "     Nginx conf.d:   ${BOLD}${NGINX_CONFD}${NC}"
    else
      echo -e "     Nginx conf.d:   ${YELLOW}nao encontrado (configure manualmente apos a instalacao)${NC}"
    fi

  else
    echo ""
    ask "1c. Deseja habilitar HTTPS com certificado SSL automatico? (via Caddy)"
    ask "    Requer que as portas 80 e 443 estejam livres no servidor."
    read -rp "    Habilitar SSL? [s/N]: " SSL_ANSWER
    SSL_ANSWER="${SSL_ANSWER:-n}"
    if [[ "$SSL_ANSWER" =~ ^[Ss]$ ]]; then
      USE_SSL="y"
      ok "HTTPS habilitado — Caddy gerenciara o certificado automaticamente"
    else
      warn "SSL desabilitado — o dashboard ficara acessivel via HTTP na porta 5173"
    fi
  fi
fi

# ── EXIM: mesmo servidor ou remoto? ───────────────────────────────────────
echo ""
ask "2. O EXIM esta no mesmo servidor que o dashboard?"
read -rp "   Mesmo servidor? [S/n]: " SAME_SERVER
SAME_SERVER="${SAME_SERVER:-s}"

if [[ "$SAME_SERVER" =~ ^[Ss]$ ]]; then
  SSH_HOST="$DOCKER_BRIDGE"
  SSH_PORT="$DETECTED_SSH_PORT"
  echo ""
  info "SSH apontara para o proprio servidor via Docker bridge: ${BOLD}${SSH_HOST}:${SSH_PORT}${NC}"
  echo ""
  ask "2b. Usuario SSH (recomendado: usuario nao-root com sudo)"
  read -rp "    Usuario SSH: " SSH_USER
  SSH_USER="${SSH_USER:-root}"
else
  echo ""
  ask "2. Servidor EXIM — conexao SSH"
  read -rp "   Host/IP do servidor EXIM: " SSH_HOST
  read -rp "   Usuario SSH (default: root): " SSH_USER
  SSH_USER="${SSH_USER:-root}"
  read -rp "   Porta SSH (default: 22): " SSH_PORT
  SSH_PORT="${SSH_PORT:-22}"
fi

# ── Chave SSH ─────────────────────────────────────────────────────────────
echo ""
GENERATED_KEY="${HOME}/.ssh/exim_backend_key"
if [[ "$REVERSE_PROXY" == "y" ]] || [[ "$SAME_SERVER" =~ ^[Ss]$ ]]; then
  # Ambiente gerenciado ou mesmo servidor: gera chave Ed25519 dedicada
  if [[ ! -f "$GENERATED_KEY" ]]; then
    info "Gerando chave SSH Ed25519 dedicada para o backend..."
    mkdir -p "${HOME}/.ssh" && chmod 700 "${HOME}/.ssh"
    ssh-keygen -t ed25519 -f "$GENERATED_KEY" -N "" -C "exim-monitor-backend"
    ok "Chave gerada em $GENERATED_KEY"
  else
    ok "Reutilizando chave existente: $GENERATED_KEY"
  fi
  SSH_KEY="$GENERATED_KEY"
else
  ask "3. Caminho da chave SSH privada no servidor"
  read -rp "   (default: ~/.ssh/id_rsa): " SSH_KEY
  SSH_KEY="${SSH_KEY:-~/.ssh/id_rsa}"
fi

# ── Credenciais do painel ─────────────────────────────────────────────────
echo ""
ask "4. Credenciais do painel web"
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
ask "5. Senha do banco de dados PostgreSQL"
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
echo -e "  EXIM SSH:       ${BOLD}$SSH_USER@$SSH_HOST:$SSH_PORT${NC}"
echo -e "  Chave SSH:      ${BOLD}$SSH_KEY${NC}"
echo -e "  Admin:          ${BOLD}$ADMIN_USER${NC}"
if [[ "$REVERSE_PROXY" == "y" ]] || [[ "$SAME_SERVER" =~ ^[Ss]$ ]]; then
  echo ""
  echo -e "  Acoes automaticas:"
  echo -e "  ${GREEN}✓${NC} Chave Ed25519 gerada/reutilizada"
  echo -e "  ${GREEN}✓${NC} Chave publica adicionada em authorized_keys do usuario ${BOLD}$SSH_USER${NC}"
  echo -e "  ${GREEN}✓${NC} diag-exim.sh implantado no servidor"
  [[ -n "$FIREWALL_SVC" ]] && \
    echo -e "  ${GREEN}✓${NC} Regra de firewall Docker adicionada (${FIREWALL_SVC})"
  [[ -n "$NGINX_CONFD" ]] && \
    echo -e "  ${GREEN}✓${NC} nginx conf.d configurado em ${NGINX_CONFD}"
fi
echo ""
read -rp "  Confirmar instalacao? [S/n]: " CONFIRM
CONFIRM="${CONFIRM:-s}"
[[ "$CONFIRM" =~ ^[Nn]$ ]] && { warn "Instalacao cancelada."; exit 0; }

# ── Clona ou atualiza repositorio ─────────────────────────────────────────
echo ""
info "Preparando arquivos..."

REPO_URL="${REPO_URL:-https://github.com/ianfcunha/exim-monitor.git}"
REPO_BRANCH="${REPO_BRANCH:-cloudez}"
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

# ── Define caminho destino do script de diagnostico ───────────────────────
if [[ "$SSH_USER" == "root" ]]; then
  SCRIPT_DEST="/root/diag-exim.sh"
else
  SCRIPT_DEST="/home/$SSH_USER/diag-exim.sh"
fi

# ── Adiciona chave publica aos authorized_keys ────────────────────────────
PUB_KEY_FILE="${SSH_KEY}.pub"
if [[ -f "$PUB_KEY_FILE" ]]; then
  if [[ "$SSH_USER" == "root" ]]; then
    AUTH_KEYS="/root/.ssh/authorized_keys"
  else
    AUTH_KEYS="/home/$SSH_USER/.ssh/authorized_keys"
    mkdir -p "/home/$SSH_USER/.ssh"
    chmod 700 "/home/$SSH_USER/.ssh"
    chown "$SSH_USER:$SSH_USER" "/home/$SSH_USER/.ssh" 2>/dev/null || true
  fi
  PUB_KEY=$(cat "$PUB_KEY_FILE")
  if ! grep -qF "$PUB_KEY" "$AUTH_KEYS" 2>/dev/null; then
    echo "$PUB_KEY" >> "$AUTH_KEYS"
    chmod 600 "$AUTH_KEYS"
    [[ "$SSH_USER" != "root" ]] && chown "$SSH_USER:$SSH_USER" "$AUTH_KEYS" 2>/dev/null || true
    ok "Chave publica adicionada a $AUTH_KEYS"
  else
    ok "Chave publica ja presente em $AUTH_KEYS"
  fi
fi

# ── Implanta diag-exim.sh ─────────────────────────────────────────────────
if [[ -f "$INSTALL_DIR/diag-exim.sh" ]]; then
  [[ "$SSH_USER" != "root" ]] && mkdir -p "/home/$SSH_USER"
  cp "$INSTALL_DIR/diag-exim.sh" "$SCRIPT_DEST"
  chmod +x "$SCRIPT_DEST"
  [[ "$SSH_USER" != "root" ]] && chown "$SSH_USER:$SSH_USER" "$SCRIPT_DEST" 2>/dev/null || true
  ok "diag-exim.sh implantado em $SCRIPT_DEST"
else
  warn "diag-exim.sh nao encontrado no repositorio"
  warn "Coloque o script em $SCRIPT_DEST e ajuste SCRIPT_PATH em backend/.env"
fi

# ── Gera backend/.env ─────────────────────────────────────────────────────
mkdir -p backend
cat > backend/.env << ENV
# EXIM Monitor — Configuracoes geradas pelo install.sh em $(date)
SSH_HOST=$SSH_HOST
SSH_PORT=$SSH_PORT
SSH_USER=$SSH_USER
SSH_KEY_PATH=$SSH_KEY

SCRIPT_PATH=$SCRIPT_DEST

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

# ── Configura regra de firewall para rede Docker ──────────────────────────
if [[ "$REVERSE_PROXY" == "y" && -n "$FIREWALL_SVC" ]]; then
  echo ""
  info "Configurando regra de firewall para rede Docker (${DOCKER_BRIDGE%.*}.0/16 → porta $DETECTED_SSH_PORT)..."
  DOCKER_SUBNET="${DOCKER_BRIDGE%.*}.0/16"

  if [[ -n "$FIREWALL_CUSTOM" ]]; then
    FIREWALL_RULE="-A INPUT -s $DOCKER_SUBNET -p tcp --dport $DETECTED_SSH_PORT -j ACCEPT"
    if ! grep -qF "$FIREWALL_RULE" "$FIREWALL_CUSTOM" 2>/dev/null; then
      echo "$FIREWALL_RULE" >> "$FIREWALL_CUSTOM"
      ok "Regra adicionada a $FIREWALL_CUSTOM"
    else
      ok "Regra ja existente em $FIREWALL_CUSTOM"
    fi
    systemctl restart "$FIREWALL_SVC" && ok "$FIREWALL_SVC reiniciado" || warn "Falha ao reiniciar $FIREWALL_SVC"
    sleep 2
    info "Reiniciando Docker para reconstruir regras de rede apos restart do firewall..."
    systemctl restart docker && ok "Docker reiniciado" || warn "Falha ao reiniciar Docker"
    sleep 3
  elif [[ "$FIREWALL_SVC" == "ufw" ]]; then
    ufw allow from "${DOCKER_BRIDGE%.*}.0/16" to any port "$DETECTED_SSH_PORT" proto tcp 2>/dev/null && \
      ok "Regra UFW adicionada" || warn "Nao foi possivel adicionar regra UFW"
  else
    iptables -I INPUT -s "$DOCKER_SUBNET" -p tcp --dport "$DETECTED_SSH_PORT" -j ACCEPT 2>/dev/null && \
      ok "Regra iptables adicionada" || warn "Adicione manualmente: iptables -I INPUT -s $DOCKER_SUBNET -p tcp --dport $DETECTED_SSH_PORT -j ACCEPT"
  fi
fi

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
echo -e "${GREEN}${BOLD}  Instalacao concluida!${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [[ "$USE_SSL" == "y" ]]; then
  echo -e "  Dashboard:  ${BLUE}https://$DOMAIN${NC}"
  echo -e "  API Docs:   ${BLUE}https://$DOMAIN/api/docs${NC}"
elif [[ "$REVERSE_PROXY" == "y" ]]; then
  echo -e "  Dashboard:  ${BLUE}http://$DOMAIN${NC}"
  echo -e "  API Docs:   ${BLUE}http://$DOMAIN/api/docs${NC}"
  echo -e "  ${YELLOW}(Para HTTPS: certbot --nginx -d $DOMAIN)${NC}"
elif [[ "$DOMAIN" == "localhost" ]]; then
  echo -e "  Dashboard:  ${BLUE}http://localhost:5173${NC}"
  echo -e "  API Docs:   ${BLUE}http://localhost:8000/api/docs${NC}"
else
  echo -e "  Dashboard:  ${BLUE}http://$DOMAIN:5173${NC}"
  echo -e "  API Docs:   ${BLUE}http://$DOMAIN:8000/api/docs${NC}"
fi

echo ""
echo -e "  Usuario:    ${BOLD}$ADMIN_USER${NC}"
echo -e "  Senha:      ${BOLD}(a que voce definiu)${NC}"
echo ""
echo -e "  Logs:       ${YELLOW}$COMPOSE_CMD logs -f backend${NC}"
echo -e "  Parar:      ${YELLOW}$COMPOSE_CMD down${NC}"
echo -e "  Atualizar:  ${YELLOW}git pull && $COMPOSE_CMD up -d --build${NC}"
echo ""

if [[ "$USE_SSL" == "y" ]]; then
  echo -e "${YELLOW}  Certifique-se de que o DNS aponta para este servidor${NC}"
  echo ""
fi
