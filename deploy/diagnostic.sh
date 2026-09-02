#!/usr/bin/env bash
# =============================================================================
# Mail IQ — coleta de diagnóstico para o suporte.
#
#   ./diagnostic.sh
#
# Complementa o pacote que o painel gera sozinho (Configurações →
# Manutenção → Baixar pacote). A divisão é proposital:
#
#   · O painel sabe do PAINEL — versão, coletor, licença, incidentes,
#     canais de alerta. Basta um navegador, e funciona mesmo se quem abriu
#     o chamado não tiver acesso SSH à máquina onde o painel roda.
#
#   · Este script sabe da MÁQUINA — containers de pé ou reiniciando, o log
#     do backend, disco, memória, versão do Docker. É exatamente o que
#     falta quando o painel não responde e, por isso mesmo, não consegue
#     gerar o próprio diagnóstico.
#
# Junta os dois num .tar.gz. Só lê: não reinicia nada, não altera nada.
#
# SEGREDOS: o .env NÃO entra aqui (ao contrário do backup.sh, onde ele é
# indispensável para o dump servir de alguma coisa). Deste arquivo só sai
# a LISTA de variáveis definidas, sem os valores — dá para responder "o
# JWT_SECRET está configurado?" sem nunca vê-lo.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")" || exit 1

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
ok()   { echo -e "${GREEN}  ✓ $*${NC}"; }
info() { echo -e "${BLUE}  → $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠ $*${NC}"; }
err()  { echo -e "${RED}  ✗ $*${NC}"; exit 1; }

LINHAS_LOG="${MAILIQ_DIAG_LOG_LINES:-500}"

COMPOSE="docker compose"
docker compose version &>/dev/null 2>&1 || COMPOSE="docker-compose"

TS="$(date +%Y%m%d-%H%M%S)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
DEST="diagnostico/${TS}"
mkdir -p "$STAGE/$DEST"

echo -e "\n${BOLD}Mail IQ — coleta de diagnóstico${NC}\n"

# ── 1. Estado dos containers ───────────────────────────────────────────────
info "Containers..."
$COMPOSE ps            > "$STAGE/$DEST/containers.txt" 2>&1
$COMPOSE ps -a --format json >> "$STAGE/$DEST/containers.txt" 2>&1
ok "estado dos containers"

# ── 2. Logs ────────────────────────────────────────────────────────────────
# Onde a causa raiz costuma estar de verdade: traceback do backend,
# Postgres recusando conexão, Caddy sem conseguir emitir certificado.
info "Últimas $LINHAS_LOG linhas de log de cada serviço..."
for svc in backend postgres caddy frontend; do
  $COMPOSE logs --no-color --tail "$LINHAS_LOG" "$svc" \
    > "$STAGE/$DEST/log-${svc}.txt" 2>&1 || rm -f "$STAGE/$DEST/log-${svc}.txt"
done
ok "logs coletados"

# ── 3. Pacote do painel (via API) ─────────────────────────────────────────
# Sem credencial não dá para chamar a rota autenticada; nesse caso o
# arquivo fica de fora e o cliente anexa o download do painel à parte.
info "Pacote do painel (API)..."
if [[ -f .env ]] && command -v curl >/dev/null; then
  U="$(grep -E '^ADMIN_USERNAME=' .env | head -1 | cut -d= -f2-)"
  P="$(grep -E '^ADMIN_PASSWORD=' .env | head -1 | cut -d= -f2-)"
  TOKEN="$(curl -s --max-time 15 -X POST http://localhost:8000/api/auth/login \
            -d "username=${U}&password=${P}" 2>/dev/null \
          | sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p')"
  if [[ -n "$TOKEN" ]]; then
    if curl -s --max-time 60 -o "$STAGE/$DEST/painel.json" \
        http://localhost:8000/api/support/diagnostic-package \
        -H "Authorization: Bearer $TOKEN" 2>/dev/null \
       && [[ -s "$STAGE/$DEST/painel.json" ]]; then
      ok "pacote do painel incluído"
    else
      rm -f "$STAGE/$DEST/painel.json"
      warn "a API respondeu, mas o pacote não veio — baixe pelo painel"
    fi
  else
    warn "não consegui autenticar na API (o painel está no ar?) — baixe o pacote pelo painel"
  fi
else
  warn "sem .env ou sem curl — baixe o pacote pelo painel e anexe junto"
fi

# ── 4. Máquina ─────────────────────────────────────────────────────────────
info "Recursos da máquina..."
{
  echo "=== data (UTC) ==="; date -u
  echo; echo "=== uname ==="; uname -a
  echo; echo "=== distro ==="; cat /etc/os-release 2>/dev/null | head -5
  echo; echo "=== disco ==="; df -h 2>/dev/null
  echo; echo "=== memória ==="; free -h 2>/dev/null
  echo; echo "=== carga ==="; uptime
  echo; echo "=== docker ==="; docker version 2>&1 | head -20
  echo; echo "=== volumes do compose ==="; docker volume ls 2>/dev/null | grep -i mailiq
  echo; echo "=== uso de disco dos volumes ==="; docker system df 2>/dev/null
} > "$STAGE/$DEST/maquina.txt" 2>&1
ok "recursos da máquina"

# ── 5. Configuração — só os NOMES das variáveis ───────────────────────────
# Nunca os valores. Responde "está configurado?" sem expor nada.
info "Variáveis definidas (nomes, sem valores)..."
{
  echo "As variáveis abaixo estão DEFINIDAS no .env. Os valores foram"
  echo "omitidos de propósito — este arquivo vai para o suporte."
  echo
  if [[ -f .env ]]; then
    while IFS= read -r linha; do
      [[ "$linha" =~ ^[[:space:]]*# || -z "$linha" ]] && continue
      nome="${linha%%=*}"
      valor="${linha#*=}"
      if [[ -z "$valor" ]]; then
        echo "  ${nome} = (vazio)"
      else
        echo "  ${nome} = (definido, ${#valor} caracteres)"
      fi
    done < .env
  else
    echo "  (.env não encontrado neste diretório)"
  fi
  echo
  echo "=== docker-compose.yml ==="
  # O compose não tem segredo: só referências a variáveis.
  cat docker-compose.yml 2>/dev/null
} > "$STAGE/$DEST/configuracao.txt" 2>&1
ok "variáveis definidas (sem valores)"

# ── 6. Rede / TLS ──────────────────────────────────────────────────────────
info "Rede e certificado..."
DOMAIN="$(grep -E '^DOMAIN=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '[:space:]')"
{
  echo "=== portas em escuta ==="
  (ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null) | head -30
  if [[ -n "$DOMAIN" ]]; then
    echo; echo "=== DNS de $DOMAIN ==="
    (getent hosts "$DOMAIN" || echo "não resolveu") 2>&1
    echo; echo "=== HTTPS ==="
    curl -sS -o /dev/null -w 'http_code=%{http_code} tls=%{ssl_verify_result} tempo=%{time_total}s\n' \
      --max-time 15 "https://${DOMAIN}/api/version" 2>&1
    echo; echo "=== /api/version (local) ==="
    curl -sS --max-time 10 http://localhost:8000/api/version 2>&1
  fi
} > "$STAGE/$DEST/rede.txt" 2>&1
ok "rede e certificado"

# ── 7. Empacota ────────────────────────────────────────────────────────────
mkdir -p diagnostico
ARQ="diagnostico/${TS}.mailiq-diagnostico.tar.gz"
tar -czf "$ARQ" -C "$STAGE" "$DEST" || err "falha ao empacotar"
chmod 600 "$ARQ"

# Rede de segurança: se um segredo do .env entrou em algum log capturado
# (um traceback com a DATABASE_URL, por exemplo), avisa. Não remove
# sozinho — remover mudaria o conteúdo do log que o suporte precisa ler;
# o certo é a pessoa saber e decidir.
if [[ -f .env ]]; then
  VAZOU=0
  while IFS= read -r linha; do
    [[ "$linha" =~ ^[[:space:]]*# || -z "$linha" ]] && continue
    nome="${linha%%=*}"; valor="${linha#*=}"
    [[ ${#valor} -lt 12 ]] && continue
    case "$nome" in
      *PASSWORD*|*SECRET*|*KEY*|*TOKEN*|*LICENSE*)
        if grep -rqF -- "$valor" "$STAGE/$DEST" 2>/dev/null; then
          warn "o valor de ${nome} aparece dentro de algum log coletado"
          VAZOU=1
        fi ;;
    esac
  done < .env
  [[ "$VAZOU" -eq 1 ]] && warn "Revise o conteúdo antes de enviar (tar -xzOf '$ARQ' | less)."
fi

echo ""
ok "Diagnóstico gerado: ${BOLD}${ARQ}${NC}"
echo -e "  Tamanho: $(du -h "$ARQ" | cut -f1)"
echo ""
echo -e "  Confira o que vai dentro antes de enviar:"
echo -e "    ${YELLOW}tar -tzf '$ARQ'${NC}"
echo -e "    ${YELLOW}tar -xzf '$ARQ' -C /tmp && less /tmp/${DEST}/log-backend.txt${NC}"
echo ""
