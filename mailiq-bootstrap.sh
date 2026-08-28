#!/usr/bin/env bash
# ============================================================
# mailiq-bootstrap.sh — Tarefa 7 (Sessão 1, pós-auditoria)
#
# Roda UMA VEZ, como root, NO SERVIDOR EXIM que você quer monitorar
# (não na máquina onde o painel do Mail IQ está rodando). Faz três
# coisas, nesta ordem:
#
#   1. Cria o usuário de sistema `mailiq` (sem senha, só chave SSH),
#      instala a chave pública informada, e adiciona o usuário aos
#      grupos de LEITURA necessários (log do Exim, spool do Exim) —
#      nada que precise de sudo é resolvido por grupo, só leitura.
#   2. Escreve /etc/sudoers.d/mailiq com uma allowlist explícita —
#      o mesmo conteúdo documentado e explicado em docs/seguranca.md,
#      auditável ali ANTES de rodar isto. Nenhum "ALL=(ALL) NOPASSWD:
#      ALL" aparece em lugar nenhum.
#   3. Sonda o que a conexão resultante consegue fazer de verdade
#      (mesma lógica de diag-exim.sh --check, ver Tarefa 4) e imprime
#      o resultado — se alguma capacidade não ficou disponível, isso
#      fica visível aqui, não descoberto depois numa ação que falha.
#
# Uso:
#   sudo bash mailiq-bootstrap.sh --pubkey 'ssh-ed25519 AAAA... mailiq@meuservidor'
#
# A chave pública normalmente vem do painel (Servidores → Adicionar →
# "Gerar chave") — cole exatamente o que ele mostrar. Sem --pubkey,
# este script gera um par de chaves NOVO aqui mesmo e imprime a
# privada no final pra você colar manualmente no painel — funciona,
# mas o caminho recomendado é deixar o painel gerar (a privada nunca
# precisa transitar por um terminal).
#
# Este script não baixa nada da internet, não manda nada pra fora
# deste servidor, e só usa a sessão de root em que você já está —
# o painel nunca vê essa sessão nem essa senha. Leia o script inteiro
# antes de rodar; ele é intencionalmente um único arquivo autocontido.
# ============================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

ok()   { echo -e "${GREEN}  ✓ $*${NC}"; }
info() { echo -e "${BLUE}  → $*${NC}"; }
warn() { echo -e "${YELLOW}  ⚠ $*${NC}"; }
err()  { echo -e "${RED}  ✗ $*${NC}"; exit 1; }

MAILIQ_USER="mailiq"
PUB_KEY=""
GENERATE_KEY_LOCALLY=0

while [ $# -gt 0 ]; do
    case "$1" in
        --pubkey)  PUB_KEY="$2"; shift 2 ;;
        --pubkey=*) PUB_KEY="${1#--pubkey=}"; shift ;;
        --user)    MAILIQ_USER="$2"; shift 2 ;;
        --user=*)  MAILIQ_USER="${1#--user=}"; shift ;;
        -h|--help)
            sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) err "Argumento desconhecido: $1 (use --pubkey 'ssh-ed25519 ...' ou --help)" ;;
    esac
done

[ "$(id -u)" -eq 0 ] || err "Rode como root (sudo bash mailiq-bootstrap.sh ...) — é a única vez que isso é necessário."

echo -e "\n${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}  Mail IQ — bootstrap do usuário ${MAILIQ_USER}${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

# ── Detecta binários e caminhos reais deste servidor ──────────────────
info "Detectando ambiente..."

# cPanel/WHM: /home é território das contas de hospedagem — um usuário de
# sistema ali pode ser varrido pelas ferramentas de conta do WHM. Nesse
# ambiente o home do mailiq vai pra /opt.
IS_CPANEL=0
if [ -d /usr/local/cpanel ]; then
    IS_CPANEL=1
    ok "Ambiente cPanel/WHM detectado — home do usuário em /opt/$MAILIQ_USER"
fi

EXIM_BIN_NAME=""
for _eb in exim4 exim; do
    command -v "$_eb" &>/dev/null && { EXIM_BIN_NAME="$_eb"; break; }
done
[ -z "$EXIM_BIN_NAME" ] && err "exim/exim4 não encontrado no PATH — este não parece ser um servidor Exim."
EXIM_BIN_PATH="$(command -v "$EXIM_BIN_NAME")"
ok "Exim: $EXIM_BIN_PATH"

EXIQGREP_PATH="$(command -v exiqgrep 2>/dev/null || true)"
[ -n "$EXIQGREP_PATH" ] && ok "exiqgrep: $EXIQGREP_PATH" || warn "exiqgrep não encontrado — ações de frozen/bounce ficarão limitadas"

IPTABLES_PATH="$(command -v iptables 2>/dev/null || true)"
CSF_PATH="$(command -v csf 2>/dev/null || true)"
FIREWALLD_PATH="$(command -v firewall-cmd 2>/dev/null || true)"
IMUNIFY_PATH="$(command -v imunify360-agent 2>/dev/null || true)"

[ -n "$CSF_PATH" ]       && ok "CSF: $CSF_PATH"
[ -n "$FIREWALLD_PATH" ] && ok "firewalld: $FIREWALLD_PATH"
[ -n "$IMUNIFY_PATH" ]   && ok "Imunify360: $IMUNIFY_PATH"
[ -z "$CSF_PATH$FIREWALLD_PATH" ] && [ -n "$IPTABLES_PATH" ] && \
    info "Sem CSF/firewalld — bloqueio de IP cairá no fallback iptables ($IPTABLES_PATH)"

# Mainlog — mesma lista de candidatos de diag-exim.sh
MAINLOG=""
for cand in /var/log/exim4/mainlog /var/log/exim/mainlog /var/log/exim_mainlog /var/log/mail.log; do
    [ -f "$cand" ] && { MAINLOG="$cand"; break; }
done
[ -n "$MAINLOG" ] && ok "Mainlog: $MAINLOG" || warn "Mainlog não encontrado nos caminhos padrão — leitura de log pode ficar indisponível"

SPOOL_DIR="$("$EXIM_BIN_PATH" -bP spool_directory 2>/dev/null | awk -F'= ' '{print $2}')"
SPOOL_DIR="${SPOOL_DIR:-/var/spool/exim4}"
ok "Spool: $SPOOL_DIR"

# ── Grupos de leitura (sem sudo) ──────────────────────────────────────
LOG_GROUP=""
if [ -n "$MAINLOG" ]; then
    LOG_GROUP="$(stat -c '%G' "$MAINLOG" 2>/dev/null || true)"
fi
# Fallback só se o stat não deu nada: adm (Debian/Ubuntu), mail (cPanel/
# RHEL/AlmaLinux), wheel (último recurso).
if [ -z "$LOG_GROUP" ]; then
    for _g in adm mail wheel; do
        getent group "$_g" >/dev/null 2>&1 && { LOG_GROUP="$_g"; break; }
    done
fi

SPOOL_GROUP=""
[ -d "$SPOOL_DIR" ] && SPOOL_GROUP="$(stat -c '%G' "$SPOOL_DIR" 2>/dev/null || true)"

# ── Chave pública ──────────────────────────────────────────────────────
GENERATED_PRIVATE_KEY=""
if [ -z "$PUB_KEY" ]; then
    warn "Nenhuma --pubkey informada — gerando um par de chaves novo aqui."
    GENERATE_KEY_LOCALLY=1
    TMP_KEY="$(mktemp -u)"
    ssh-keygen -t ed25519 -f "$TMP_KEY" -N "" -C "mailiq@$(hostname -f 2>/dev/null || hostname)" >/dev/null
    PUB_KEY="$(cat "${TMP_KEY}.pub")"
    GENERATED_PRIVATE_KEY="$(cat "$TMP_KEY")"
    rm -f "$TMP_KEY" "${TMP_KEY}.pub"
fi

echo "$PUB_KEY" | grep -qE '^ssh-(ed25519|rsa) ' || err "--pubkey não parece uma chave pública SSH válida (esperado começar com 'ssh-ed25519 ' ou 'ssh-rsa ')"

# ── Cria o usuário ──────────────────────────────────────────────────────
echo ""
info "Configurando usuário $MAILIQ_USER..."
if id "$MAILIQ_USER" &>/dev/null; then
    ok "Usuário $MAILIQ_USER já existe — reaproveitando (home: $(getent passwd "$MAILIQ_USER" | cut -d: -f6))"
else
    # Shell de verdade (bash), não nologin: SSH de execução de comando
    # (client.exec_command() do backend) precisa de um shell que
    # realmente interprete o comando — nologin recusaria.
    if [ "$IS_CPANEL" -eq 1 ]; then
        useradd --home-dir "/opt/$MAILIQ_USER" --create-home -s /bin/bash \
            -c "Mail IQ service account" "$MAILIQ_USER"
        ok "Usuário $MAILIQ_USER criado em /opt/$MAILIQ_USER (fora de /home — cPanel)"
    else
        useradd -m -s /bin/bash -c "Mail IQ service account" "$MAILIQ_USER"
        ok "Usuário $MAILIQ_USER criado (home + /bin/bash — necessário pra SSH de comando funcionar; nologin recusaria)"
    fi
fi

USER_HOME="$(getent passwd "$MAILIQ_USER" | cut -d: -f6)"
SSH_DIR="$USER_HOME/.ssh"
mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"
AUTH_KEYS="$SSH_DIR/authorized_keys"
touch "$AUTH_KEYS"
if grep -qF "$PUB_KEY" "$AUTH_KEYS" 2>/dev/null; then
    ok "Chave pública já presente em $AUTH_KEYS"
else
    echo "$PUB_KEY" >> "$AUTH_KEYS"
    ok "Chave pública adicionada a $AUTH_KEYS"
fi
chmod 600 "$AUTH_KEYS"
chown -R "$MAILIQ_USER:$MAILIQ_USER" "$SSH_DIR"

for grp in "$LOG_GROUP" "$SPOOL_GROUP"; do
    [ -z "$grp" ] && continue
    if id -nG "$MAILIQ_USER" | tr ' ' '\n' | grep -qxF "$grp"; then
        ok "Já é membro do grupo $grp"
    else
        usermod -aG "$grp" "$MAILIQ_USER"
        ok "Adicionado ao grupo $grp (leitura de log/spool, sem precisar de sudo)"
    fi
done

# ── Diretórios de uso exclusivo do Mail IQ ─────────────────────────────
# Dono = mailiq, pra list-quarantine/list-blocks não precisarem de sudo
# só pra navegar (ver diag-exim.sh, comentário perto de QUARANTINE_ROOT).
mkdir -p /var/log/exim-monitor /var/spool/exim_quarantine
chown "$MAILIQ_USER:$MAILIQ_USER" /var/log/exim-monitor /var/spool/exim_quarantine
chmod 750 /var/log/exim-monitor /var/spool/exim_quarantine
ok "Diretórios /var/log/exim-monitor e /var/spool/exim_quarantine prontos (dono: $MAILIQ_USER)"

# ── sudoers — allowlist explícita (ver docs/seguranca.md) ─────────────
echo ""
info "Escrevendo /etc/sudoers.d/$MAILIQ_USER..."

SUDOERS_TMP="$(mktemp)"
{
    echo "# /etc/sudoers.d/$MAILIQ_USER — gerado por mailiq-bootstrap.sh em $(date)"
    echo "# NAO EDITE A MAO — rode o bootstrap de novo se precisar ajustar caminhos."
    echo "Defaults:$MAILIQ_USER !requiretty"
    echo "Defaults:$MAILIQ_USER secure_path=\"/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\""
    echo ""
    echo "# Fila: remover, ver header, forcar reprocessamento (cap_remove_messages)"
    echo "$MAILIQ_USER ALL=(root) NOPASSWD: $EXIM_BIN_PATH -Mrm *"
    echo "$MAILIQ_USER ALL=(root) NOPASSWD: $EXIM_BIN_PATH -Mvh *"
    echo "$MAILIQ_USER ALL=(root) NOPASSWD: $EXIM_BIN_PATH -qff"
    echo "$MAILIQ_USER ALL=(root) NOPASSWD: $EXIM_BIN_PATH -bp"
    echo "$MAILIQ_USER ALL=(root) NOPASSWD: $EXIM_BIN_PATH -bpc"
    echo "$MAILIQ_USER ALL=(root) NOPASSWD: $EXIM_BIN_PATH -bP *"
    [ -n "$EXIQGREP_PATH" ] && echo "$MAILIQ_USER ALL=(root) NOPASSWD: $EXIQGREP_PATH *"
    echo ""
    echo "# Quarentena: copiar mensagem antes/depois de remover (cap_quarantine)"
    echo "$MAILIQ_USER ALL=(root) NOPASSWD: /usr/bin/cp -p $SPOOL_DIR/input/* /var/spool/exim_quarantine/*"
    echo "$MAILIQ_USER ALL=(root) NOPASSWD: /usr/bin/cp -p /var/spool/exim_quarantine/*/* $SPOOL_DIR/input/*"
    echo "$MAILIQ_USER ALL=(root) NOPASSWD: /usr/bin/find $SPOOL_DIR/input *"
    echo "$MAILIQ_USER ALL=(root) NOPASSWD: /usr/bin/test -r $SPOOL_DIR/input"
    echo ""
    if [ -n "$CSF_PATH" ] || [ -n "$FIREWALLD_PATH" ] || [ -n "$IPTABLES_PATH" ]; then
        echo "# Bloqueio de IP (cap_manage_firewall)"
        [ -n "$CSF_PATH" ] && {
            echo "$MAILIQ_USER ALL=(root) NOPASSWD: $CSF_PATH -td *"
            echo "$MAILIQ_USER ALL=(root) NOPASSWD: $CSF_PATH -tr *"
            echo "$MAILIQ_USER ALL=(root) NOPASSWD: $CSF_PATH -dr *"
            echo "$MAILIQ_USER ALL=(root) NOPASSWD: $CSF_PATH -t"
            echo "$MAILIQ_USER ALL=(root) NOPASSWD: $CSF_PATH -g *"
        }
        [ -n "$FIREWALLD_PATH" ] && {
            echo "$MAILIQ_USER ALL=(root) NOPASSWD: $FIREWALLD_PATH --state"
            echo "$MAILIQ_USER ALL=(root) NOPASSWD: $FIREWALLD_PATH --add-rich-rule=* --timeout=*"
        }
        [ -n "$IPTABLES_PATH" ] && {
            echo "$MAILIQ_USER ALL=(root) NOPASSWD: $IPTABLES_PATH -C INPUT -s * -j DROP"
            echo "$MAILIQ_USER ALL=(root) NOPASSWD: $IPTABLES_PATH -I INPUT -s * -j DROP"
            echo "$MAILIQ_USER ALL=(root) NOPASSWD: $IPTABLES_PATH -D INPUT -s * -j DROP"
        }
        [ -n "$IMUNIFY_PATH" ] && {
            echo "$MAILIQ_USER ALL=(root) NOPASSWD: $IMUNIFY_PATH ip-list local delete --purpose black *"
            echo "$MAILIQ_USER ALL=(root) NOPASSWD: $IMUNIFY_PATH ip-list local add --purpose white *"
            echo "$MAILIQ_USER ALL=(root) NOPASSWD: $IMUNIFY_PATH ip-list local list --by-ip *"
        }
        echo ""
        echo "# Persistencia de bloqueio (fallback iptables)"
        echo "$MAILIQ_USER ALL=(root) NOPASSWD: /usr/bin/mkdir -p /etc/firewall.d"
        echo "$MAILIQ_USER ALL=(root) NOPASSWD: /usr/bin/tee /etc/firewall.d/03_custom"
        echo "$MAILIQ_USER ALL=(root) NOPASSWD: /usr/bin/tee -a /etc/firewall.d/03_custom"
        echo "$MAILIQ_USER ALL=(root) NOPASSWD: /usr/bin/tee /etc/firewall.d/03_custom.tmp"
        echo "$MAILIQ_USER ALL=(root) NOPASSWD: /usr/bin/mv /etc/firewall.d/03_custom.tmp /etc/firewall.d/03_custom"
        echo "$MAILIQ_USER ALL=(root) NOPASSWD: /usr/bin/chmod 640 /etc/firewall.d/03_custom"
        echo ""
    fi
    if [ "$IS_CPANEL" -eq 1 ] || [ ! -d /etc/exim4 ]; then
        echo "# Bloqueio de remetente: indisponível neste ambiente."
        echo "# A ação usa /etc/exim4/spammer_sender (pacote exim4 do Debian);"
        echo "# em cPanel/WHM o bloqueio de remetente é pelo Exim Configuration"
        echo "# Manager ou pela suspensão da conta. cap_write_blacklist ficará"
        echo "# 'false' no --check e o painel desabilita o botão com o motivo."
        echo ""
    else
        echo "# Bloqueio de remetente (cap_write_blacklist)"
        echo "$MAILIQ_USER ALL=(root) NOPASSWD: /usr/bin/tee -a /etc/exim4/spammer_sender"
        echo "$MAILIQ_USER ALL=(root) NOPASSWD: /usr/bin/test -w /etc/exim4"
        echo ""
    fi
    echo "# Bookkeeping interno (TTL de bloqueio, log de auditoria)"
    echo "$MAILIQ_USER ALL=(root) NOPASSWD: /usr/bin/tee -a /var/log/exim-monitor/actions.log"
    echo "$MAILIQ_USER ALL=(root) NOPASSWD: /usr/bin/tee /var/log/exim-monitor/ip_blocks.tsv*"
    echo "$MAILIQ_USER ALL=(root) NOPASSWD: /usr/bin/tee -a /var/log/exim-monitor/ip_blocks.tsv"
    echo "$MAILIQ_USER ALL=(root) NOPASSWD: /usr/bin/mv /var/log/exim-monitor/ip_blocks.tsv.tmp /var/log/exim-monitor/ip_blocks.tsv"
} > "$SUDOERS_TMP"

visudo -c -f "$SUDOERS_TMP" >/dev/null || err "sudoers gerado é inválido (visudo -c falhou) — nada foi instalado, veja $SUDOERS_TMP"
install -m 440 -o root -g root "$SUDOERS_TMP" "/etc/sudoers.d/$MAILIQ_USER"
rm -f "$SUDOERS_TMP"
ok "/etc/sudoers.d/$MAILIQ_USER escrito e validado (visudo -c)"

# ── Sondagem de capacidade (mesma lógica de diag-exim.sh --check, T4) ──
echo ""
info "Sondando o que a conexão consegue fazer..."

SUDO_L="$(sudo -n -l -U "$MAILIQ_USER" 2>/dev/null || true)"
# "--" e checagem de padrão vazio são essenciais aqui: um padrão que
# começa com "-" (ex.: "-Mrm") sem "--" faz o grep tentar interpretar
# o próprio padrão como opção (mesmo bug pego em diag-exim.sh na
# Tarefa 4); e grep -F com padrão VAZIO casa qualquer linha — sem a
# checagem de vazio, uma ferramenta não instalada (ex.: $CSF_PATH="")
# apareceria como "disponível" só por acidente.
_probe() {
    [ -z "$1" ] && return 1
    printf '%s' "$SUDO_L" | grep -qF -- "$1"
}

probe_result() {
    local label="$1" ok_cond="$2"
    if [ "$ok_cond" = "1" ]; then
        echo -e "  ${GREEN}✓${NC} $label"
    else
        echo -e "  ${YELLOW}⚠${NC} $label ${DIM}(indisponível — revise o sudoers acima)${NC}"
    fi
}

if _probe "-Mrm"; then R1=1; else R1=0; fi
probe_result "Remover mensagens da fila" "$R1"

R2=0
if _probe "$IPTABLES_PATH" || _probe "$CSF_PATH" || _probe "$FIREWALLD_PATH"; then
    R2=1
fi
probe_result "Bloquear IP" "$R2"

if _probe "spammer_sender"; then R3=1; else R3=0; fi
probe_result "Bloquear remetente" "$R3"

if sudo -n -u "$MAILIQ_USER" test -r "$SPOOL_DIR/input" 2>/dev/null; then R4=1; else R4=0; fi
probe_result "Quarentenar mensagens antes de remover" "$R4"

if [ -n "$MAINLOG" ] && sudo -n -u "$MAILIQ_USER" test -r "$MAINLOG" 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} Ler o mainlog (grupo $LOG_GROUP)"
else
    echo -e "  ${YELLOW}⚠${NC} Ler o mainlog ${DIM}(confira o grupo dono de $MAINLOG)${NC}"
fi

# ── Resumo final — o que colar no painel ───────────────────────────────
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}${BOLD}  Pronto — dados para o painel${NC}"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"
echo -e "  Host:            ${BOLD}$(hostname -f 2>/dev/null || hostname)${NC}"
echo -e "  Usuário SSH:     ${BOLD}$MAILIQ_USER${NC}"
echo -e "  Tipo de auth:    ${BOLD}chave (key)${NC}"
echo -e "  Caminho remoto:  ${BOLD}$USER_HOME/diag-exim.sh${NC} ${DIM}(o painel envia por SFTP ao cadastrar/testar — use este caminho no campo \"Caminho do script\")${NC}"
echo ""

if [ "$GENERATE_KEY_LOCALLY" -eq 1 ]; then
    warn "Chave gerada aqui (não pelo painel) — cole a PRIVADA abaixo no campo"
    warn "'Chave privada' do cadastro do servidor no painel:"
    echo ""
    echo -e "${DIM}${GENERATED_PRIVATE_KEY}${NC}"
    echo ""
    warn "Copie AGORA — este script não guarda uma cópia dela."
else
    ok "A chave privada correspondente já está salva no painel (ele gerou o par) —"
    ok "não é preciso colar nada, só clicar em \"Testar conexão\" no cadastro deste servidor."
fi

echo ""
echo -e "  Sudoers instalado em: ${YELLOW}/etc/sudoers.d/$MAILIQ_USER${NC} (audite quando quiser — docs/seguranca.md)"
echo ""
