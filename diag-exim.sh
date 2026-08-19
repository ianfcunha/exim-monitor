#!/bin/bash
# ============================================================
# EXIM MONITOR PRO v5.0 — Diagnóstico Inteligente de Fila
# ============================================================
# Uso:   bash exim-monitor.sh [--auto] [--json] [--clean-spam]
#        --auto          executa sem interação (modo cron/alerta)
#        --json          saída em JSON para integração externa
#        --clean-spam    limpa fila automaticamente se SPAM detectado
#        --check         verifica pré-requisitos do servidor:
#                          JSON {ok, checks:[exim_binary,exiqgrep,disk_space,
#                          mainlog,cpanel,csf,imunify360,open_relay,starttls,
#                          exim_version_cve]}
#        --quick         modo leve para dashboard (heartbeat ~30s):
#                          skip de exim -bp e exiqgrep; lê log com
#                          suporte a rotation (mainlog.1/.gz);
#                          linhas escaladas por --hours=N;
#                          retorna JSON com mode:"quick" + hourly_stats
#        --hours=N       janela de análise por hora (padrão 6);
#                          em --quick ajusta QUICK_LOG_LINES dinamicamente
#        --action=<cmd>  executa uma ação isolada e retorna JSON:
#                          clean-full | clean-frozen | clean-bounces
#                          clean-sender:<addr> | clean-auth:<user>
#                          block-ip:<ip> | block-sender:<addr> | retry-queue
#                          check-deliverability[:dominio] — blocklists via
#                          DNSBL + SPF/DKIM/DMARC + expiração do cert TLS
#                          (STARTTLS na porta 25), sem alterar nada
#                          check-ip-status --ip=<ip> — status em CSF/
#                          Imunify360/MagicSpam (monitoramento)
#                          unblock-ip --ip=<ip> --tool=csf|imunify360
#        --snapshot=0    desativa o before_snapshot das ações destrutivas
#                          acima (ligado por padrão — ver Changelog v5.7)
# ============================================================
# Changelog v5.9:
#   - Novo em --check: 3 checks informativos de configuração insegura
#           comum (mesmo padrão de cpanel/csf/imunify360, não afetam o
#           "ok" geral):
#             open_relay        — lê "exim -bP config" (funciona em
#                                  Debian split-config e no exim.conf
#                                  monolítico do cPanel) e sinaliza só
#                                  padrão inequívoco de host coringa em
#                                  relay_from_hosts (*, 0.0.0.0/0, ::/0)
#             starttls          — confirma que STARTTLS está sendo
#                                  oferecido na porta 25; não exige
#                                  obrigatoriedade (forçar quebraria
#                                  entrega de remetentes legados)
#             exim_version_cve  — compara a versão contra uma lista
#                                  PEQUENA e mantida à mão de CVEs
#                                  críticos conhecidos (CVE-2019-10149,
#                                  pacote 21Nails) — não é uma feed ao
#                                  vivo, precisa de revisão manual
#                                  periódica pra continuar útil
# ============================================================
# Changelog v5.8:
#   - Novo: "queue.size_distribution" no JSON completo (--json/--action) —
#           over_1mb/over_5mb/under_10kb + "sampled" (true quando a fila é
#           grande demais e size_distribution reflete só a amostra lida,
#           não a fila inteira — mesma amostragem de QUEUE_LIMIT já usada
#           pros outros agregados). Novo diagnóstico FILA_MENSAGENS_GRANDES
#           em classify() — só dispara quando mensagens >5MB são MAIORIA
#           da fila (não só presentes em meio a milhares de pequenas, que
#           já cai em SPAM_MASSIVO/FILA_ALTA); threshold configurável via
#           EXIM_TH_QUEUE_MSGS_GRANDES (default 3).
#   - Fix: QUEUE_SIZE (campo "size_kb") somava a coluna 2 de "exim -bp"
#           sem converter o sufixo K/M/G ("50K" virava 50, "2.0M" virava
#           2.0) — subestimava o tamanho real da fila em até ~1000x
#           quando havia mensagens grandes. analyze_age() agora converte
#           pra bytes antes de somar (mesma lógica usada pro novo
#           size_distribution).
#   - Fix (bug pré-existente real, achado testando o item acima): "exim -bp"
#           preenche a coluna de idade com um espaço à esquerda pra idades
#           curtas (" 4m", não "4m") — analyze_senders() e show_relay_detail()
#           filtravam linhas de cabeçalho com /^[0-9]/ contra a linha inteira,
#           que nunca batia nesse caso (a maioria das filas reais, já que a
#           maior parte das mensagens tem idade de 1 dígito). TOP_SENDER,
#           TOP_SENDER_DOMAINS, BOUNCE_COUNT e a detecção de RELAY_SUSPECT
#           ficavam silenciosamente vazios/zerados. Corrigido pra checar $1
#           (idade, já sem o padding — awk separa campos por whitespace
#           independente da indentação) — mesmo padrão que analyze_age() já
#           usava corretamente pra OLD_DAYS/HOURS/MINS.
#   - Fix: exim-test.sh --clean e o bloco --freeze de inject() usavam
#           "exiqgrep -s" (filtra pelo campo de TAMANHO) em vez de "-f"
#           (filtra por sender) — nunca encontravam as mensagens injetadas
#           pelo próprio script, silenciosamente. exim-test.sh também ganhou
#           --size (K/M) pra injetar mensagens de tamanho controlado, usado
#           pra validar o size_distribution acima.
# ============================================================
# Changelog v5.7:
#   - Novo: before_snapshot no JSON de ações destrutivas (clean-full/
#           frozen/bounces/sender/auth, block-ip/sender) — estado
#           relevante capturado ANTES de mutar (contagem + amostra de IDs
#           da fila afetada, ou se o IP/sender já estava bloqueado) para
#           dar visibilidade real de auditoria, não é undo — mensagens
#           removidas continuam removidas. Ligado por padrão; --snapshot=0
#           desativa (ex.: filas gigantes onde o usuário não quer o custo
#           extra de listar IDs antes de limpar).
# ============================================================
# Changelog v5.6:
#   - Novo: check_cert_json() — expiração do certificado TLS via STARTTLS
#           na porta 25 (openssl s_client + x509 -enddate), somado à saída
#           de --action=check-deliverability como "cert": {valid,
#           days_remaining, expires_at}. EXIM_TH_CERT_DAYS (15) é o
#           threshold sugerido para "perto de expirar" — usado pelo
#           backend, não pelo script (script só coleta dado estruturado).
# ============================================================
# Changelog v5.5:
#   - Novo: --action=check-ip-status --ip=<ip> — consulta CSF (csf -g +
#           lfd.log) e Imunify360 (ip-list local list --by-ip --json);
#           MagicSpam entra só como monitoramento/TODO (cliente resolve
#           desbloqueio direto no painel dele)
#   - Novo: --action=unblock-ip --ip=<ip> --tool=csf|imunify360 — csf -tr/
#           -dr (temp/permanente conforme csf -t) ou whitelist no
#           Imunify360 (ip-list local add --purpose white)
#   - Novo: EXIM_CSF_BIN / EXIM_IMUNIFY_BIN — nomes de binário
#           configuráveis via env var, mesmo padrão dos EXIM_TH_*
#   - Novo: checks "csf" (agora via EXIM_CSF_BIN) e "imunify360" em
#           --check
#   - Novo: _collect_exim_resources() — substitui a contagem simples
#           (pgrep -c) por amostra real via `ps -C exim -o pid,%cpu,%mem,
#           etime`; soma EXIM_CPU_TOTAL/EXIM_MEM_TOTAL e guarda top-3
#           processos por CPU; campos cpu_total/mem_total/top_processes
#           no JSON ("exim": {...}), ambos os modos (quick e full)
#   - Novo: EXIM_TH_CPU_PCT (80) / EXIM_TH_MEM_PCT (70) — thresholds do
#           novo tipo de problema ALTO_CONSUMO_RECURSOS em classify();
#           ação recomendada é só textual (sem restart automático)
#   - Novo: analyze_suspicious_tlds() — conta envios ("=>") do LOG_SAMPLE
#           para domínios com TLD em EXIM_SUSPICIOUS_TLDS (lista padrão
#           configurável); EXIM_TH_TLD_SUSPEITA (20) dispara o novo tipo
#           de problema TLD_SUSPEITA em classify(). Não cobre ACL
#           específica de cliente (TODO — depende do ambiente real)
# Changelog v5.4:
#   - Novo: /var/log/exim_mainlog (padrão cPanel/WHM) nos fallbacks de log
#           usados por --quick, --json e --check, mantendo os caminhos
#           Debian/exim4 já existentes
#   - Novo: leitura de log rotacionado reconhece o padrão de data do
#           cPanel/WHM (exim_mainlog-YYYYMMDD.gz), além de mainlog.1(.gz)
#   - Novo: checks "cpanel" e "csf" em --check — informativos, não afetam
#           o "ok" geral; usados pelo backend para detectar o ambiente
#   - Fix: modo completo de collect() (usado por --json) ainda não tinha
#           /var/log/exim_mainlog na lista de fallback — só --quick e
#           --check tinham sido corrigidos. Lista de candidatos extraída
#           para o array único LOG_CANDIDATES (topo do script), consumido
#           pelos três pontos — evita essa lacuna se repetir
#   - Fix: detecção de IP público em check_blacklists() tinha só um
#           fallback (hostname -I), podendo silenciosamente testar um IP
#           privado; _detect_public_ip() tenta dois serviços externos e
#           valida que o resultado não é privado antes de aceitar
#   - Novo: --action=check-deliverability[:dominio] — blocklists (DNSBL)
#           e SPF/DKIM/DMARC como JSON estruturado, sem alterar nada no
#           servidor; reaproveita a mesma detecção de IP/domínio da
#           versão interativa (check_blacklists / check_dkim_spf)
# Changelog v5.1:
#   - Novo: GLOBAL_TIMEOUT=120 — controla todos os timeouts de coleta (T2-1);
#          substitui os "timeout 120" hardcoded; watchdog em collect() define
#          COLLECT_TIMED_OUT=1 se a coleta total exceder o limite
#   - Novo: campo "error" no JSON — exim -bpc falhando gera mensagem estruturada
#          em vez de campo vazio; backend diferencia dados vs falha (T2-2)
#   - Novo: modo --check — retorna JSON {"ok":bool,"checks":[...]} com
#          EXIM_BIN, exiqgrep, disco, mainlog; usado no cadastro SaaS (T2-3)
#   - Novo: campo "script_version" em todos os JSONs — backend valida
#          compatibilidade de schema antes de processar (T2-4)
#   - Novo: campo "mainlog_size_mb" no JSON — tamanho do mainlog via du;
#          integra com alertas de crescimento anormal (T2-5)
# Changelog v5.0:
#   - Fix: compatibilidade exim4 vs exim — detecta automaticamente o
#          binário correto (Debian/Ubuntu usam exim4); EXIM_BIN global
#          substituindo todas as chamadas hardcoded a "exim"
#   - Fix: timeout 120s em exim -bp — evita travar indefinidamente em
#          filas muito grandes; ações também têm timeout individual
#   - Novo: queue.frozen no modo --quick — exiqgrep -z com timeout 10s
#          expõe frozen_count no JSON rápido (antes era sempre 0)
#   - Novo: top_rejected_domains[] e top_defer_domains[] no JSON —
#          arrays já calculados em analyze_log() agora exportados
#          em ambos os modos (quick e full); helper _domains_to_json()
#   - Fix: sanitização de parâmetros em ações — clean-sender, clean-auth
#          e block-ip validam input antes de passar para exiqgrep/iptables;
#          helper _validate_action_param() rejeita metacaracteres de shell
#   - Novo: diagnosis.actions_recommended[] — array de ações sugeridas
#          embutido no objeto diagnosis para cada cenário detectado;
#          permite ao dashboard sugerir a ação correta automaticamente
#   - Fix: campos numéricos no JSON usam ${VAR:-0} para evitar JSON inválido
#          quando variável não está definida (ex: BOUNCE_COUNT no quick)
# Changelog v4.9:
#   - Novo: thresholds configuráveis via variável de ambiente
#           (EXIM_TH_AUTH_ABUSE=100, EXIM_TH_FILA_ALTA=1000, etc.)
#   - Novo: suporte a log rotation — lê mainlog.1.gz / mainlog.1
#           automaticamente antes de aplicar tail -N (ambos modos)
#   - Novo: --hours=N em --quick: QUICK_LOG_LINES escala com a janela
#           (HOURS_WINDOW * 500, mín 1000), cobrindo o período pedido
#   - Novo: hourly_stats[] no JSON do --quick (recv/sent por hora)
#   - Novo: campo php_mailers{} no JSON --json (suspicious, mail_calls,
#           top_suspect) via analyze_php_mailers_json() com timeout
#   - Novo: suporte a Exim 4.96+ — awk de hourly_stats tolera timestamps
#           com sub-segundo; exim.version adicionado ao JSON
#   - Novo: detect_exim_version() — detecta e expõe versão do Exim
# Changelog v4.8:
#   - Novo: --quick — modo leve de coleta para polling de dashboard;
#           pula exim -bp e exiqgrep, lê apenas 500 linhas de log,
#           JSON retorna mode:"quick" e omite campos dependentes de fila
#   - Novo: --action=<cmd> — executa ação pontual sem diagnóstico;
#           retorna JSON {"success":bool,"action":"...","message":"..."}
#           útil para chamadas POST de uma API REST
# Changelog v4.7:
#   - Novo: analyze_hourly_stats() — conta mensagens recebidas (<=) e
#           entregues (=>) por hora das últimas N horas (padrão 6h)
#   - Novo: print_hourly_stats() — exibe tabela visual com barras por hora
#   - Novo: opção [h] no menu para ver tráfego por hora (sem poluir relatório)
#   - Novo: argumento --hours=N para configurar a janela de análise
#   - Novo: bar_c() — variante colorida da bar() para distinção visual
# Changelog v4.6:
#   - Fix: remoção do script disponível somente ao sair [0]; [r] recarrega
#          sem perguntar (comportamento v4.5 corrigido)
# Changelog v4.5:
#   - Novo: QUEUE_CLEANED flag — marcado em todas as funções de limpeza
#   - Novo: maybe_delete_script() — pergunta se quer excluir o script
#           somente em [0] (sair)
# Changelog v4.4:
#   - Menu: [x] "Limpar TODA a fila" adicionado à seção Geral — disponível
#           em todos os cenários, exibe contagem atual e pede confirmação
# Changelog v4.3:
#   - Ajuste: block_ip_firewall_d() solicita número do ticket antes de
#             gravar; cria 03_custom se não existir; sem chamada a iptables
#             diretamente — usa somente firewall.service restart para aplicar
#   - Ajuste: checagem de duplicata exibe as linhas existentes no arquivo
# Changelog v4.2:
#   - Reorg: main() imprime Status+Diagnóstico primeiro (toda análise roda
#            antes de imprimir qualquer coisa), seções de detalhe depois
#   - Novo: block_ip_firewall_d() — aplica iptables E persiste em
#           /etc/firewall.d/03_custom (checagem de duplicata incluída)
#   - Fix: block_ip_iptables() substituída por block_ip_firewall_d() no menu
# Changelog v4.1:
#   - Fix: grep lookbehind variável em analyze_defers() trocado por \K
#   - Fix: destinatários em exim -bp ficam em linhas indentadas separadas;
#          awk ajustado para /^[[:space:]]/ em vez de /^[0-9]/
#   - Fix: extração de domínio remetente captura explicitamente após @
#          (evita pegar local-parts com ponto, ex: case.file@domain → domain)
# ============================================================

# Sessões SSH não-interativas (exec_command via paramiko, por exemplo)
# às vezes não carregam o PATH completo do shell de login — garante que
# binários em /usr/sbin, /sbin e /usr/local/sbin (onde exim, iptables,
# exiqgrep etc. costumam morar) sejam encontrados mesmo assim.
export PATH="$PATH:/usr/sbin:/sbin:/usr/local/sbin"

VERSION="5.9"
LOG_PATH="/var/log/exim4/mainlog"
# Lista única de candidatos a mainlog — consumida por collect() (quick e
# completo) e run_check(). Debian/exim4, Debian/exim genérico, cPanel/WHM
# (/var/log/exim_mainlog) e syslog genérico (mail.log), nesta ordem.
# Adicione novos ambientes aqui — não duplique a lista em outros pontos.
LOG_CANDIDATES=(
    "/var/log/exim4/mainlog"
    "/var/log/exim/mainlog"
    "/var/log/exim_mainlog"
    "/var/log/mail.log"
)
LOG_LINES=10000
QUEUE_SAMPLE_THRESHOLD=10000  # acima disso usa amostra da fila
QUEUE_LINES=5000
HOURS_WINDOW=6                # janela padrão para análise por hora
GLOBAL_TIMEOUT=120            # timeout total de coleta em segundos (T2-1)
SNAPSHOT_SAMPLE_LIMIT=20      # max de IDs de mensagem no before_snapshot de acoes destrutivas

# ── Thresholds de classificação — configuráveis via variável de ambiente ──
# Exemplo: EXIM_TH_AUTH_ABUSE=100 bash diag-exim.sh --quick
TH_SPAM_RELAY_SEND=${EXIM_TH_SPAM_RELAY_SEND:-30}
TH_SPAM_RELAY_BOUNCE=${EXIM_TH_SPAM_RELAY_BOUNCE:-10}
TH_SPAM_MASSIVO_QUEUE=${EXIM_TH_SPAM_MASSIVO_QUEUE:-5000}
TH_SPAM_MASSIVO_SENDS=${EXIM_TH_SPAM_MASSIVO_SENDS:-200}
TH_SPAM_MASSIVO_SENDER=${EXIM_TH_SPAM_MASSIVO_SENDER:-500}
TH_AUTH_ABUSE=${EXIM_TH_AUTH_ABUSE:-200}
TH_BOUNCE_CONCENTRADO=${EXIM_TH_BOUNCE_CONCENTRADO:-100}
TH_BOUNCE_CONCENTRADO_RCPT=${EXIM_TH_BOUNCE_CONCENTRADO_RCPT:-50}
TH_IP_FLOOD=${EXIM_TH_IP_FLOOD:-500}
TH_FILA_TRAVADA_DAYS=${EXIM_TH_FILA_TRAVADA_DAYS:-100}
TH_FILA_TRAVADA_FROZEN=${EXIM_TH_FILA_TRAVADA_FROZEN:-50}
TH_ALTO_DEFERIMENTO=${EXIM_TH_ALTO_DEFERIMENTO:-500}
TH_BOUNCE_STORM=${EXIM_TH_BOUNCE_STORM:-500}
TH_ALTA_REJEICAO=${EXIM_TH_ALTA_REJEICAO:-500}
TH_FILA_ALTA=${EXIM_TH_FILA_ALTA:-2000}
TH_CPU_PCT=${EXIM_TH_CPU_PCT:-80}
TH_MEM_PCT=${EXIM_TH_MEM_PCT:-70}
TH_TLD_SUSPEITA=${EXIM_TH_TLD_SUSPEITA:-20}
TH_CERT_DAYS=${EXIM_TH_CERT_DAYS:-15}   # dias restantes p/ considerar cert TLS perto de expirar
TH_QUEUE_MSGS_GRANDES=${EXIM_TH_QUEUE_MSGS_GRANDES:-3}  # min. de msgs >5MB p/ considerar FILA_MENSAGENS_GRANDES
# Lista de TLDs consideradas de alto risco/abuso — configurável, mesmo
# padrão dos EXIM_TH_*. Não cobre a ACL específica de um cliente (ver
# analyze_suspicious_tlds abaixo).
EXIM_SUSPICIOUS_TLDS="${EXIM_SUSPICIOUS_TLDS:-zip,top,xyz,work,click,country,stream}"
DATE=$(date "+%Y-%m-%d %H:%M:%S")
# Timestamp ISO 8601 em UTC com sufixo Z — usado só nos campos "timestamp"
# do JSON. $DATE (hora local do servidor, sem timezone) segue sendo usado
# em textos pra humano (audit log, comentário em firewall.d): sem o "Z",
# o JS do dashboard interpreta a string como hora LOCAL DO NAVEGADOR, não
# UTC — se o servidor e o navegador estiverem em fusos diferentes, o
# painel mostra "há Xs" negativo (timestamp "no futuro").
DATE_ISO=$(date -u "+%Y-%m-%dT%H:%M:%SZ")
HOSTNAME=$(hostname -f 2>/dev/null || hostname)
# ── Detectar binário exim (exim4 em Debian/Ubuntu, exim em outros) ──
EXIM_BIN=""
for _eb in exim4 exim; do
    command -v "$_eb" &>/dev/null && { EXIM_BIN="$_eb"; break; }
done
# ── CSF / Imunify360 — nomes de binário configuráveis via env var ──
# Caminho exato ainda não confirmado no ambiente real do cliente (cPanel/
# WHM com CSF + Imunify360 + MagicSpam); mesmo padrão de configurabilidade
# já usado pelos thresholds EXIM_TH_* — permite override sem editar o script.
EXIM_CSF_BIN="${EXIM_CSF_BIN:-csf}"
EXIM_IMUNIFY_BIN="${EXIM_IMUNIFY_BIN:-imunify360-agent}"
# Prefixar sudo quando não for root (ambientes sem acesso root direto)
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
else
    SUDO=""
fi


AUTO_MODE=0; JSON_MODE=0; CLEAN_SPAM_AUTO=0; QUICK_MODE=0; CHECK_MODE=0
ACTION_CMD=""; ACTION_PARAM=""
ACTOR_NAME=""          # T3-3: usuário que disparou a ação (--actor=)
PROFILE="standard"     # T3-4: perfil de coleta (light|standard|full)
IP_PARAM=""            # --action=check-ip-status/unblock-ip: --ip=<ip>
TOOL_PARAM=""           # --action=unblock-ip: --tool=csf|imunify360
SNAPSHOT_MODE=1         # --action=<destrutiva>: captura before_snapshot por padrao; --snapshot=0 desativa
for arg in "$@"; do
    case "$arg" in
        --auto)        AUTO_MODE=1 ;;
        --json)        JSON_MODE=1 ;;
        --clean-spam)  CLEAN_SPAM_AUTO=1 ;;
        --hours=*)     HOURS_WINDOW="${arg#--hours=}" ;;
        --quick)       QUICK_MODE=1; JSON_MODE=1 ;;
        --check)       CHECK_MODE=1; JSON_MODE=1 ;;
        --action=*)
            _actraw="${arg#--action=}"
            ACTION_CMD="${_actraw%%:*}"
            ACTION_PARAM="${_actraw#*:}"
            [ "$ACTION_CMD" = "$ACTION_PARAM" ] && ACTION_PARAM=""
            JSON_MODE=1
            ;;
        --actor=*)     ACTOR_NAME="${arg#--actor=}" ;;
        --profile=*)   PROFILE="${arg#--profile=}" ;;
        --ip=*)        IP_PARAM="${arg#--ip=}" ;;
        --tool=*)      TOOL_PARAM="${arg#--tool=}" ;;
        --snapshot=*)  SNAPSHOT_MODE="${arg#--snapshot=}" ;;
    esac
done

if [ -t 1 ] && [ "$JSON_MODE" -eq 0 ]; then
    RED='\033[0;31m';   LRED='\033[1;31m'
    YELLOW='\033[1;33m'; GREEN='\033[0;32m'; LGREEN='\033[1;32m'
    CYAN='\033[0;36m';  LCYAN='\033[1;36m'
    MAGENTA='\033[0;35m'; WHITE='\033[1;37m'
    BOLD='\033[1m';     DIM='\033[2m';       RESET='\033[0m'
    BGRED='\033[41m';   BGYELLOW='\033[43m'; BGGREEN='\033[42m'
else
    RED=''; LRED=''; YELLOW=''; GREEN=''; LGREEN=''
    CYAN=''; LCYAN=''; MAGENTA=''; WHITE=''
    BOLD=''; DIM=''; RESET=''; BGRED=''; BGYELLOW=''; BGGREEN=''
fi

hr()      { printf '%0.s─' $(seq 1 72); echo; }
hr_thin() { printf '%0.s·' $(seq 1 72); echo; }
section() { echo; echo -e "${LCYAN}╔═  $1${RESET}"; hr; }
subsec()  { echo -e "${BOLD}${WHITE}  ▸ $1${RESET}"; }
badge_ok()   { echo -e "${BGGREEN}${BOLD}  ✔ $1  ${RESET}"; }
badge_warn() { echo -e "${BGYELLOW}${BOLD}  ⚠ $1  ${RESET}"; }
badge_crit() { echo -e "${BGRED}${BOLD}  ✖ $1  ${RESET}"; }

bar() {
    local val=$1 max=$2 width=${3:-30}
    [ "$max" -eq 0 ] && max=1
    local filled=$(( val * width / max ))
    [ "$filled" -gt "$width" ] && filled=$width
    local empty=$(( width - filled ))
    printf "${CYAN}["
    printf '%0.s█' $(seq 1 $filled) 2>/dev/null
    printf '%0.s░' $(seq 1 $empty)  2>/dev/null
    printf "]${RESET} ${BOLD}%s${RESET}" "$val"
}

# Igual a bar(), mas aceita cor como primeiro argumento
bar_c() {
    local color=$1 val=$2 max=$3 width=${4:-30}
    [ "$max" -eq 0 ] && max=1
    local filled=$(( val * width / max ))
    [ "$filled" -gt "$width" ] && filled=$width
    local empty=$(( width - filled ))
    printf "${color}["
    printf '%0.s█' $(seq 1 $filled) 2>/dev/null
    printf '%0.s░' $(seq 1 $empty)  2>/dev/null
    printf "]${RESET} ${BOLD}%s${RESET}" "$val"
}

check_deps() {
    local missing=0
    # Exim pode ser 'exim4' (Debian/Ubuntu) ou 'exim' (outros)
    if [ -z "$EXIM_BIN" ]; then
        echo -e "${RED}[ERRO] Faltando: exim ou exim4 — instale o Exim MTA${RESET}" >&2
        missing=1
    fi
    # exiqgrep: aviso (não fatal) — apenas ações de fila dependem dele
    command -v exiqgrep &>/dev/null || \
        echo -e "${YELLOW}[AVISO] exiqgrep não encontrado — ações sobre frozen/bounce limitadas${RESET}" >&2
    for cmd in awk grep sed sort uniq wc tail head; do
        command -v "$cmd" &>/dev/null || { echo -e "${RED}[ERRO] Faltando: $cmd${RESET}" >&2; missing=1; }
    done
    [ "$missing" -eq 1 ] && exit 1
}

# ============================================================
# DETECTAR IPs PRÓPRIOS DO SERVIDOR
# ============================================================
get_server_ips() {
    SERVER_IPS="127.0.0.1"
    if command -v hostname &>/dev/null; then
        SERVER_IPS="$SERVER_IPS
$(hostname -I 2>/dev/null | tr ' ' '\n')"
    fi
    if command -v ip &>/dev/null; then
        SERVER_IPS="$SERVER_IPS
$(ip addr show 2>/dev/null | grep -oP '(?<=inet )\d+\.\d+\.\d+\.\d+')"
    elif command -v ifconfig &>/dev/null; then
        SERVER_IPS="$SERVER_IPS
$(ifconfig 2>/dev/null | grep -oP '(?<=inet )\d+\.\d+\.\d+\.\d+')"
    fi
    SERVER_IPS="$SERVER_IPS
$(getent hosts "$HOSTNAME" 2>/dev/null | awk '{print $1}')"
    SERVER_IPS=$(echo "$SERVER_IPS" | sort -u | grep -v '^$')
}

is_own_ip() { echo "$SERVER_IPS" | grep -qxF "$1"; }

# ============================================================
# DETECÇÃO DE VERSÃO DO EXIM
# Popula EXIM_VER_STR, EXIM_VER_MAJOR, EXIM_VER_MINOR.
# Usado para ajustar regex e emitir versão no JSON.
# ============================================================
detect_exim_version() {
    EXIM_VER_STR=$("$EXIM_BIN" --version 2>/dev/null | head -1 \
        | grep -oP 'Exim version \K[0-9]+\.[0-9]+(\.[0-9]+)?')
    [ -z "$EXIM_VER_STR" ] && EXIM_VER_STR="unknown"
    EXIM_VER_MAJOR=$(echo "$EXIM_VER_STR" | cut -d. -f1)
    EXIM_VER_MINOR=$(echo "$EXIM_VER_STR" | cut -d. -f2)
    [ -z "$EXIM_VER_MAJOR" ] && EXIM_VER_MAJOR=0
    [ -z "$EXIM_VER_MINOR" ] && EXIM_VER_MINOR=0
}

# ============================================================
# CONSUMO DE RECURSOS DOS PROCESSOS DO EXIM
# Substitui a contagem simples (pgrep -c) por uma amostra real via ps,
# somando %CPU/%MEM de todos os processos e guardando o top-3 por CPU
# para diagnóstico (feedback de cliente: dashboard não mostrava consumo
# de recursos, só contagem de processos).
# Popula: EXIM_PROCS, EXIM_CPU_TOTAL, EXIM_MEM_TOTAL, EXIM_TOP_PROC_JSON
# ============================================================
_collect_exim_resources() {
    local ps_out
    ps_out=$(ps -C "$EXIM_BIN" -o pid,%cpu,%mem,etime --no-headers 2>/dev/null)
    if [ -z "$ps_out" ]; then
        # Fallback legado (formato `ps aux`): USER PID %CPU %MEM ... — sem
        # etime nesse formato, usa "-" como placeholder.
        ps_out=$(ps aux 2>/dev/null | grep "[e]xim" \
            | awk '{printf "%s %s %s -\n", $2, $3, $4}')
    fi

    EXIM_PROCS=$(printf '%s\n' "$ps_out" | grep -c .)
    [ -z "$EXIM_PROCS" ] && EXIM_PROCS=0

    EXIM_CPU_TOTAL=$(printf '%s\n' "$ps_out" | awk '{c+=$2} END{printf "%.1f", c+0}')
    EXIM_MEM_TOTAL=$(printf '%s\n' "$ps_out" | awk '{m+=$3} END{printf "%.1f", m+0}')
    [ -z "$EXIM_CPU_TOTAL" ] && EXIM_CPU_TOTAL="0.0"
    [ -z "$EXIM_MEM_TOTAL" ] && EXIM_MEM_TOTAL="0.0"

    EXIM_TOP_PROC_JSON=$(printf '%s\n' "$ps_out" | sort -rn -k2 | head -3 | awk '
        { printf "%s{\"pid\":%s,\"cpu\":%s,\"mem\":%s,\"etime\":\"%s\"}", (NR>1?",":""), $1, $2, $3, $4 }')
    EXIM_TOP_PROC_JSON="[${EXIM_TOP_PROC_JSON}]"
}

# ============================================================
# LEITURA DO LOG COM SUPORTE A LOG ROTATION
# Tenta ler mainlog.1.gz → mainlog.1 → mainlog (fallback).
# Reconhece também o padrão de rotação do cPanel/WHM, que não usa
# sufixo numérico e sim data: exim_mainlog-YYYYMMDD.gz.
# Concatena rotacionado + atual e retorna as últimas N linhas.
# Garante cobertura de janelas maiores sem depender só do log ativo.
# ============================================================
_read_log_lines() {
    local log_path="$1" lines="$2"
    local rotated="${log_path}.1"
    local rotated_gz="${log_path}.1.gz"
    # Padrão cPanel/WHM: exim_mainlog-YYYYMMDD.gz (sem sufixo numérico)
    local rotated_dated_gz
    rotated_dated_gz=$(ls -1 "${log_path}"-[0-9]*.gz 2>/dev/null | sort -r | head -1)
    if [ -f "$rotated_gz" ]; then
        { zcat "$rotated_gz" 2>/dev/null; cat "$log_path" 2>/dev/null; } | tail -"$lines"
    elif [ -f "$rotated" ]; then
        { cat "$rotated" 2>/dev/null; cat "$log_path" 2>/dev/null; } | tail -"$lines"
    elif [ -n "$rotated_dated_gz" ]; then
        { zcat "$rotated_dated_gz" 2>/dev/null; cat "$log_path" 2>/dev/null; } | tail -"$lines"
    else
        tail -"$lines" "$log_path" 2>/dev/null
    fi
}

# ============================================================
# COLETA
# ============================================================
# Arquivos temporários para coleta paralela
_TMP_QUEUE=""
_TMP_LOG=""
_TMP_FROZEN=""

# Spinner simples para mostrar atividade enquanto coleta em background
_spinner() {
    local pid=$1 msg=$2
    local frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
    local i=0
    # Só exibe spinner se tiver TTY
    [ -t 1 ] || { wait "$pid" 2>/dev/null; return; }
    while kill -0 "$pid" 2>/dev/null; do
        local f="${frames:$((i % ${#frames})):1}"
        printf "\r  ${CYAN}%s${RESET} ${DIM}%s...${RESET}" "$f" "$msg"
        sleep 0.12
        i=$((i+1))
    done
    printf "\r%-60s\r" " "   # limpa linha do spinner
}

collect() {
    # Limpeza de temporários órfãos com mais de 1h — proteção adicional
    # ao trap de EXIT/INT/TERM (linha ~511): se a conexão SSH cair no
    # meio de uma coleta anterior, o trap não roda e o arquivo fica pra
    # trás. Não é limpeza da coleta atual (criada logo abaixo), só do
    # lixo deixado por execuções anteriores que não terminaram limpo.
    find /tmp -maxdepth 1 -name 'eximmon_*' -mmin +60 -delete 2>/dev/null

    # Contagem rápida primeiro (exim -bpc é instantâneo)
    COLLECT_ERROR=""
    COLLECT_TIMED_OUT=0
    local _bpc_out
    _bpc_out=$("$EXIM_BIN" -bpc 2>/dev/null)
    if [ $? -ne 0 ] || [ -z "$_bpc_out" ]; then
        COLLECT_ERROR="exim -bpc falhou — verifique se o Exim esta em execucao"
        QUEUE=0
    else
        QUEUE="$_bpc_out"
    fi

    # ── Modo quick: coleta mínima para heartbeat de dashboard ───────
    # Pula exim -bp (lento) e exiqgrep; lê QUICK_LOG_LINES de log.
    # QUICK_LOG_LINES escala com HOURS_WINDOW (≈500 linhas/hora).
    # Suporte a log rotation: lê mainlog.1(.gz) + mainlog atual.
    # Variáveis dependentes de fila ficam vazias/zero — indicado no JSON.
    QUICK_LOG_LINES=$(( HOURS_WINDOW * 500 ))
    [ "$QUICK_LOG_LINES" -lt 1000 ] && QUICK_LOG_LINES=1000
    if [ "$QUICK_MODE" -eq 1 ]; then
        # Watchdog global (T2-1)
        local _WDOG_FILE; _WDOG_FILE=$(mktemp /tmp/eximmon_wdog.XXXXXX)
        ( sleep "$GLOBAL_TIMEOUT" && echo "1" > "$_WDOG_FILE" ) </dev/null >/dev/null 2>&1 &
        local _WDOG_PID=$!
        _FOUND_LOG=""
        for candidate in "${LOG_CANDIDATES[@]}"; do
            [ -f "$candidate" ] && { _FOUND_LOG="$candidate"; LOG_PATH="$candidate"; break; }
        done
        # T2-5: tamanho do mainlog
        MAINLOG_SIZE_MB=0
        if [ -n "$_FOUND_LOG" ]; then
            local _mls; _mls=$(du -sm "$_FOUND_LOG" 2>/dev/null | awk '{print $1}')
            MAINLOG_SIZE_MB=${_mls:-0}
        fi
        _TMP_LOG=$(mktemp /tmp/eximmon_log.XXXXXX)
        [ -n "$_FOUND_LOG" ] && _read_log_lines "$_FOUND_LOG" "$QUICK_LOG_LINES" > "$_TMP_LOG"
        QUEUE_RAW=""; OLDEST_IN_QUEUE=""
        # Frozen count no quick — exiqgrep -z com timeout curto (10s)
        FROZEN_COUNT=$(timeout 10 exiqgrep -z -i 2>/dev/null | wc -l | tr -d '[:space:]')
        [ -z "$FROZEN_COUNT" ] && FROZEN_COUNT=0
        QUEUE_SAMPLED=0
        LOG_SAMPLE=$(cat "$_TMP_LOG" 2>/dev/null)
        rm -f "$_TMP_LOG"
        _collect_exim_resources
        EXIM_PID=$(cat /var/run/exim4/exim.pid 2>/dev/null || pgrep -n "$EXIM_BIN" 2>/dev/null)
        [ -n "$EXIM_PID" ] && EXIM_UPTIME=$(ps -p "$EXIM_PID" -o etime= 2>/dev/null | xargs) || EXIM_UPTIME="N/A"
        [ -s "$_WDOG_FILE" ] && COLLECT_TIMED_OUT=1
        kill "$_WDOG_PID" 2>/dev/null; wait "$_WDOG_PID" 2>/dev/null
        rm -f "$_WDOG_FILE"
        return
    fi

    # ── Modo normal: coleta completa ────────────────────────────────
    # Watchdog global (T2-1)
    local _WDOG_FILE; _WDOG_FILE=$(mktemp /tmp/eximmon_wdog.XXXXXX)
    ( sleep "$GLOBAL_TIMEOUT" && echo "1" > "$_WDOG_FILE" ) </dev/null >/dev/null 2>&1 &
    local _WDOG_PID=$!
    # Decide limite de leitura da fila baseado no tamanho
    QUEUE_SAMPLED=0
    if [ "$QUEUE" -gt "$QUEUE_SAMPLE_THRESHOLD" ]; then
        # Fila grande: lê amostra do início + fim para cobrir msgs antigas e recentes
        QUEUE_LIMIT=$(( QUEUE_LINES / 2 ))
        QUEUE_SAMPLED=1
    else
        QUEUE_LIMIT="$QUEUE_LINES"
    fi

    # Localiza o log antes de disparar coleta paralela
    _FOUND_LOG=""
    for candidate in "${LOG_CANDIDATES[@]}"; do
        [ -f "$candidate" ] && { _FOUND_LOG="$candidate"; LOG_PATH="$candidate"; break; }
    done

    # T2-5: tamanho do mainlog
    MAINLOG_SIZE_MB=0
    if [ -n "$_FOUND_LOG" ]; then
        local _mls; _mls=$(du -sm "$_FOUND_LOG" 2>/dev/null | awk '{print $1}')
        MAINLOG_SIZE_MB=${_mls:-0}
    fi

    # Arquivos temporários
    _TMP_QUEUE=$(mktemp /tmp/eximmon_queue.XXXXXX)
    _TMP_LOG=$(mktemp   /tmp/eximmon_log.XXXXXX)
    _TMP_FROZEN=$(mktemp /tmp/eximmon_frozen.XXXXXX)

    # ── Coleta paralela em background ───────────────────────────────
    # Job 1: fila
    {
        if [ "$QUEUE_SAMPLED" -eq 1 ]; then
            # Amostra: primeiras QUEUE_LIMIT linhas (msgs antigas) +
            #          últimas QUEUE_LIMIT linhas (msgs recentes)
            { timeout "$GLOBAL_TIMEOUT" "$EXIM_BIN" -bp 2>/dev/null | head -"$QUEUE_LIMIT";
              timeout "$GLOBAL_TIMEOUT" "$EXIM_BIN" -bp 2>/dev/null | tail -"$QUEUE_LIMIT"; } > "$_TMP_QUEUE"
        else
            timeout "$GLOBAL_TIMEOUT" "$EXIM_BIN" -bp 2>/dev/null | head -"$QUEUE_LIMIT" > "$_TMP_QUEUE"
        fi
    } &
    _PID_QUEUE=$!

    # Job 2: log (com suporte a log rotation — mainlog.1.gz / mainlog.1)
    {
        [ -n "$_FOUND_LOG" ] && _read_log_lines "$_FOUND_LOG" "$LOG_LINES" > "$_TMP_LOG"
    } &
    _PID_LOG=$!

    # Job 3: frozen (exiqgrep pode ser lento em filas grandes)
    {
        exiqgrep -z -i 2>/dev/null | wc -l > "$_TMP_FROZEN"
    } &
    _PID_FROZEN=$!

    # ── Mostra progresso enquanto espera ────────────────────────────
    if [ -t 1 ] && [ "$JSON_MODE" -eq 0 ]; then
        printf "  ${DIM}Coletando dados${RESET}"
        [ "$QUEUE_SAMPLED" -eq 1 ] && printf " ${YELLOW}(fila grande: usando amostra de %s msgs)${RESET}" "$QUEUE_LIMIT"
        echo

        # Aguarda cada job com spinner individual
        _spinner "$_PID_QUEUE"  "lendo fila ($QUEUE msgs)"
        _spinner "$_PID_LOG"    "lendo log (últimas $LOG_LINES linhas)"
        _spinner "$_PID_FROZEN" "contando frozen"
    fi

    # Garante que todos os jobs terminaram
    wait "$_PID_QUEUE"  2>/dev/null
    wait "$_PID_LOG"    2>/dev/null
    wait "$_PID_FROZEN" 2>/dev/null

    # Lê resultados dos arquivos temporários para variáveis
    QUEUE_RAW=$(cat "$_TMP_QUEUE" 2>/dev/null)
    LOG_SAMPLE=$(cat "$_TMP_LOG"  2>/dev/null)
    FROZEN_COUNT=$(cat "$_TMP_FROZEN" 2>/dev/null | tr -d '[:space:]')
    [ -z "$FROZEN_COUNT" ] && FROZEN_COUNT=0

    # Limpeza dos temporários
    rm -f "$_TMP_QUEUE" "$_TMP_LOG" "$_TMP_FROZEN"

    OLDEST_IN_QUEUE=$(echo "$QUEUE_RAW" | awk 'NR==1{print $1}')
    _collect_exim_resources
    EXIM_PID=$(cat /var/run/exim4/exim.pid 2>/dev/null || pgrep -n "$EXIM_BIN" 2>/dev/null)
    [ -n "$EXIM_PID" ] && EXIM_UPTIME=$(ps -p "$EXIM_PID" -o etime= 2>/dev/null | xargs) || EXIM_UPTIME="N/A"
    [ -s "$_WDOG_FILE" ] && COLLECT_TIMED_OUT=1
    kill "$_WDOG_PID" 2>/dev/null; wait "$_WDOG_PID" 2>/dev/null
    rm -f "$_WDOG_FILE"
}

# Limpa temporários se o script for interrompido
trap 'rm -f /tmp/eximmon_*.* 2>/dev/null' EXIT INT TERM

# ============================================================
# ANÁLISE DE REMETENTES — parser corrigido para formato real exim -bp
# Formato de cabeçalho: "2m  13K  ID  <remetente>"
# Formato de destinatário: linhas indentadas com espaço "           dest@dom"
# ============================================================
analyze_senders() {
    # FIX v5.8: exim -bp alinha a coluna de idade com um espaço de
    # preenchimento à esquerda pra idades curtas (ex.: " 4m", não "4m") —
    # /^[0-9]/ contra $0 nunca batia nessas linhas (a maioria das filas
    # reais, já que a maior parte das mensagens tem menos de 10 unidades
    # de idade), fazendo TOP_SENDER/BOUNCE_COUNT/RELAY_SUSPECT ficarem
    # silenciosamente vazios/zerados sempre que a fila era "jovem".
    # $1 (idade) já vem sem o padding — awk separa campos por whitespace
    # independente de quantos espaços tem antes — então o filtro correto
    # é no valor de $1, não em $0. Mesmo padrão já usado em analyze_age().
    local _hdr='$1 ~ /^[0-9]+[dhm]$/'

    # Remetentes com endereço (exclui <>)
    TOP_SENDERS=$(echo "$QUEUE_RAW" | \
        awk "$_hdr"'{
            n=split($4,a,"[<>]")
            if(a[2]!="" && a[2]!="<>") print a[2]
        }' | sort | uniq -c | sort -rn | head -15)

    # FIX v4.1: captura o domínio explicitamente após @ até o fechamento >
    # O split anterior por [<>@] pegava local-parts com ponto (ex: case.file)
    # antes do domínio real. Agora usamos regex para extrair m[1] = domínio.
    TOP_SENDER_DOMAINS=$(echo "$QUEUE_RAW" | \
        awk "$_hdr"'{
            if(match($4,/@([^>@]+)>/,m)) print m[1]
        }' | grep -v '^$' | sort | uniq -c | sort -rn | head -10)

    BOUNCE_COUNT=$(echo "$QUEUE_RAW" | \
        awk "$_hdr"'{ if($4=="<>") c++ } END{print c+0}')

    TOP_SENDER=$(echo "$TOP_SENDERS" | head -1 | awk '{print $2}')
    TOP_SENDER_COUNT=$(echo "$TOP_SENDERS" | head -1 | awk '{print $1}')
    [ -z "$TOP_SENDER_COUNT" ] && TOP_SENDER_COUNT=0

    # ── Detecção de relay: mesmo endereço como From e como alvo de bounces
    RELAY_SUSPECT=""; RELAY_SUSPECT_SEND=0; RELAY_SUSPECT_BOUNCE=0
    RELAY_TARGET_DOMAINS=""

    if [ -n "$TOP_SENDER" ] && [ "$TOP_SENDER_COUNT" -gt 30 ]; then
        RELAY_SUSPECT="$TOP_SENDER"
        RELAY_SUSPECT_SEND="$TOP_SENDER_COUNT"
        # Bounces (<>) cujo destinatário contém o endereço suspeito
        RELAY_SUSPECT_BOUNCE=$(echo "$QUEUE_RAW" | \
            awk -v addr="$RELAY_SUSPECT" "$_hdr"'{ if($4=="<>" && $5~addr) c++ } END{print c+0}')
        # Domínios para quem o suspeito enviou
        RELAY_TARGET_DOMAINS=$(echo "$QUEUE_RAW" | \
            awk -v addr="$RELAY_SUSPECT" "$_hdr"'{ if($4~addr){ match($5,/@([^>]+)/,m); if(m[1]!="") print m[1] } }' | \
            sort | uniq -c | sort -rn | head -10)
    fi
}

# ============================================================
# ANÁLISE DE DESTINATÁRIOS
# ============================================================
# FIX v4.1: o formato de exim -bp coloca os destinatários em linhas
# próprias com indentação (espaços), NÃO na mesma linha do cabeçalho.
# O código anterior filtrava /^[0-9]/ (linhas de cabeçalho), que nunca
# contém o destinatário — por isso retornava "Nenhum destinatário".
# Agora filtramos /^[[:space:]]/ para pegar as linhas de destinatário.
# ============================================================
analyze_recipients() {
    TOP_RECIPIENTS=$(echo "$QUEUE_RAW" | \
        awk '/^[[:space:]]/{
            match($0,/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/,m)
            if(m[0]!="") print m[0]
        }' | \
        sort | uniq -c | sort -rn | head -15)

    TOP_DEST_DOMAINS=$(echo "$QUEUE_RAW" | \
        awk '/^[[:space:]]/{
            match($0,/@([a-zA-Z0-9.\-]+)/,m)
            if(m[1]!="") print m[1]
        }' | \
        sort | uniq -c | sort -rn | head -10)

    TOP_DEST_DOMAIN=$(echo "$TOP_DEST_DOMAINS" | head -1 | awk '{print $2}')
    TOP_DEST_DOMAIN_COUNT=$(echo "$TOP_DEST_DOMAINS" | head -1 | awk '{print $1}')
    [ -z "$TOP_DEST_DOMAIN_COUNT" ] && TOP_DEST_DOMAIN_COUNT=0

    TOP_RECIPIENT=$(echo "$TOP_RECIPIENTS" | head -1 | awk '{print $2}')
    TOP_RECIPIENT_COUNT=$(echo "$TOP_RECIPIENTS" | head -1 | awk '{print $1}')
    [ -z "$TOP_RECIPIENT_COUNT" ] && TOP_RECIPIENT_COUNT=0
}

# ============================================================
# ANÁLISE DO LOG
# ============================================================
analyze_log() {
    AUTH_USERS=$(echo "$LOG_SAMPLE" | grep " <= " | \
        grep -oP '(?<=A=)[^ ]+' | sort | uniq -c | sort -rn | head -15)
    TOP_AUTH_USER=$(echo "$AUTH_USERS" | head -1 | awk '{print $2}')
    TOP_AUTH_COUNT=$(echo "$AUTH_USERS" | head -1 | awk '{print $1}')
    [ -z "$TOP_AUTH_COUNT" ] && TOP_AUTH_COUNT=0

    # IPs — filtra os próprios do servidor
    ALL_IPS_RAW=$(echo "$LOG_SAMPLE" | grep " <= " | \
        grep -oP '\[\K[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(?=\])' | \
        sort | uniq -c | sort -rn)

    TOP_IPS=""; TOP_OWN_IP=""; TOP_OWN_IP_COUNT=0; TOP_OWN_IP_ADDR=""
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        ip=$(echo "$line" | awk '{print $2}')
        cnt=$(echo "$line" | awk '{print $1}')
        if is_own_ip "$ip"; then
            [ "$TOP_OWN_IP_COUNT" -eq 0 ] && { TOP_OWN_IP_COUNT="$cnt"; TOP_OWN_IP_ADDR="$ip"; }
        else
            TOP_IPS="${TOP_IPS}${line}
"
        fi
    done <<< "$ALL_IPS_RAW"
    TOP_IPS=$(echo "$TOP_IPS" | grep -v '^$' | head -15)
    TOP_IP=$(echo "$TOP_IPS" | head -1 | awk '{print $2}')
    TOP_IP_COUNT=$(echo "$TOP_IPS" | head -1 | awk '{print $1}')
    [ -z "$TOP_IP_COUNT" ] && TOP_IP_COUNT=0

    REJECT_COUNT=$(echo "$LOG_SAMPLE"  | grep -cE ' rejected | 5[0-9]{2} ')
    DEFER_COUNT=$(echo "$LOG_SAMPLE"   | grep -cE '== .* defer |Deferred:')
    BOUNCE_LOG_COUNT=$(echo "$LOG_SAMPLE" | grep -c 'Bounce\|bounce\|bounced')
    DELIVERED_COUNT=$(echo "$LOG_SAMPLE"  | grep -cE '=>.*T=')
    RECENT_SENDS=$(echo "$LOG_SAMPLE"     | grep -c ' <= ')
    DNS_ERRORS=$(echo "$LOG_SAMPLE"       | grep -cE 'DNS|lookup|NXDOMAIN')

    TOP_REJECTED_DOMAINS=$(echo "$LOG_SAMPLE" | grep -E ' rejected | 5[0-9]{2} ' | \
        grep -oP '@\K[a-zA-Z0-9.-]+' | sort | uniq -c | sort -rn | head -8)

    TOP_DEFER_DOMAINS=$(echo "$LOG_SAMPLE" | grep -E 'defer|Deferred' | \
        grep -oP '@\K[a-zA-Z0-9.-]+' | sort | uniq -c | sort -rn | head -8)
}

# ============================================================
# ENVIOS PARA TLDs SUSPEITAS
# Conta, nas linhas "=>" (entregues) do LOG_SAMPLE, quantos envios no
# período foram para domínios cujo TLD está em EXIM_SUSPICIOUS_TLDS.
# Destinatário = token logo após " => " — mesmo parsing confirmado
# contra amostra real do mainlog no Passo 3 (get_log_entries_ranged /
# _parse_log_line em backend/app/ssh.py): nas linhas de entrega, esse
# token é de fato o destinatário (T= logo depois é o nome do transport,
# não faz parte do endereço).
# TODO: não implementa a ACL específica do cliente que bloqueia TLDs no
# Exim dele — depende do texto exato da regra/log dele, só será
# confirmado quando ele liberar acesso ao ambiente real. Isso aqui é só
# a lista padrão configurável.
# ============================================================
analyze_suspicious_tlds() {
    TLD_SUSPEITA_COUNT=0
    TLD_SUSPEITA_DOMAINS=""
    [ -z "$EXIM_SUSPICIOUS_TLDS" ] && return

    local tld_alt
    tld_alt=$(echo "$EXIM_SUSPICIOUS_TLDS" | tr ',' '|')

    local recipients
    recipients=$(echo "$LOG_SAMPLE" | grep ' => ' | \
        grep -oP '(?<= => )[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+' | \
        grep -iE "\\.(${tld_alt})\$")

    TLD_SUSPEITA_COUNT=$(echo "$recipients" | grep -c .)
    [ -z "$TLD_SUSPEITA_COUNT" ] && TLD_SUSPEITA_COUNT=0

    TLD_SUSPEITA_DOMAINS=$(echo "$recipients" | grep -oP '@\K.*' | \
        sort | uniq -c | sort -rn | head -10)
}


# ============================================================
# ANÁLISE DE TRÁFEGO POR HORA
# Conta mensagens recebidas (<=) e entregues (=>) no LOG_SAMPLE
# por hora, cobrindo as últimas HOURS_WINDOW horas.
# ============================================================
analyze_hourly_stats() {
    local hours="${HOURS_WINDOW:-6}"

    # Processa LOG_SAMPLE e agrega por hora
    # Chave de saída: "YYYY-MM-DD-HH recv sent"
    # Nota: padrão de timestamp é tolerante a sub-segundo (Exim 4.96+)
    # — o campo $2 começa com HH: independente da precisão configurada.
    HOURLY_RAW=$(printf '%s\n' "$LOG_SAMPLE" | awk '
    /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}/ {
        hkey = substr($1,1,10) "-" substr($2,1,2)
        if (index($0, " <= ") > 0) recv[hkey]++
        if (index($0, " => ") > 0) sent[hkey]++
    }
    END {
        for (h in recv) print h, (recv[h]+0), ((h in sent) ? sent[h] : 0)
        for (h in sent) if (!(h in recv)) print h, 0, sent[h]
    }')

    HOURLY_HOURS=()
    HOURLY_RECV=()
    HOURLY_SENT=()
    TOTAL_RECV_WINDOW=0
    TOTAL_SENT_WINDOW=0

    local i hkey label match r s
    for i in $(seq $((hours-1)) -1 0); do
        hkey=$(date -d "$i hours ago" '+%Y-%m-%d-%H')
        label=$(date -d "$i hours ago" '+%H:00')
        match=$(echo "$HOURLY_RAW" | grep "^${hkey} " | head -1)
        r=0; s=0
        if [ -n "$match" ]; then
            r=$(echo "$match" | awk '{print $2}')
            s=$(echo "$match" | awk '{print $3}')
        fi
        r=${r:-0}; s=${s:-0}
        HOURLY_HOURS+=("$label")
        HOURLY_RECV+=("$r")
        HOURLY_SENT+=("$s")
        TOTAL_RECV_WINDOW=$(( TOTAL_RECV_WINDOW + r ))
        TOTAL_SENT_WINDOW=$(( TOTAL_SENT_WINDOW + s ))
    done
}

# ============================================================
# ANÁLISE DETALHADA DE DEFERIMENTOS
# ============================================================
analyze_defers() {
    if [ "$DEFER_COUNT" -lt 10 ]; then
        DEFER_DETAIL_AVAILABLE=0; return
    fi
    DEFER_DETAIL_AVAILABLE=1

    # Linhas de defer do log
    DEFER_LINES=$(echo "$LOG_SAMPLE" | grep -E ' == .* defer | \*\* .* SMTP error |Deferred:')

    # FIX v4.1: lookbehind variável '(?<=SMTP error from remote (?:mail server )?after )'
    # causava "lookbehind assertion is not fixed length" no grep POSIX/BRE.
    # Substituído por \K (reset de posição), que não é um lookbehind e não tem
    # restrição de tamanho fixo.
    DEFER_ERRORS=$(echo "$DEFER_LINES" | \
        grep -oP '(?<=defer \().*?(?=\))|SMTP error from remote (?:mail server )?after \K.*|(?<=Deferred: ).*' | \
        sed 's/^[[:space:]]*//' | grep -v '^$' | \
        sort | uniq -c | sort -rn | head -10)
    # Fallback: captura código 4xx/5xx + texto da linha
    if [ -z "$DEFER_ERRORS" ]; then
        DEFER_ERRORS=$(echo "$DEFER_LINES" | \
            grep -oP '[45][0-9]{2}[- ].*' | \
            cut -c1-120 | sort | uniq -c | sort -rn | head -10)
    fi

    # Destinatários com mais defers
    DEFER_RECIPIENTS=$(echo "$DEFER_LINES" | \
        grep -oP '(?<== )[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}' | \
        sort | uniq -c | sort -rn | head -10)

    # Janela temporal dos defers no log
    DEFER_FIRST_TIME=$(echo "$DEFER_LINES" | head -1 | awk '{print $1, $2}')
    DEFER_LAST_TIME=$(echo  "$DEFER_LINES" | tail -1 | awk '{print $1, $2}')
    DEFER_SPAN_MIN=0; DEFER_RATE=0
    if [ -n "$DEFER_FIRST_TIME" ] && [ -n "$DEFER_LAST_TIME" ]; then
        T1=$(date -d "$DEFER_FIRST_TIME" +%s 2>/dev/null)
        T2=$(date -d "$DEFER_LAST_TIME"  +%s 2>/dev/null)
        if [ -n "$T1" ] && [ -n "$T2" ] && [ "$T2" -gt "$T1" ]; then
            DEFER_SPAN_MIN=$(( (T2 - T1) / 60 ))
            [ "$DEFER_SPAN_MIN" -gt 0 ] && \
                DEFER_RATE=$(( DEFER_COUNT / DEFER_SPAN_MIN )) || \
                DEFER_RATE="$DEFER_COUNT"
        fi
    fi

    # Interpretação automática por domínio/erro
    DEFER_INTERPRETATION=""
    TOP_DEFER_DOMAIN=$(echo "$TOP_DEFER_DOMAINS" | head -1 | awk '{print $2}')
    TOP_DEFER_ERROR=$(echo  "$DEFER_ERRORS"      | head -1 | awk '{$1=""; print}' | sed 's/^ //')
    case "$TOP_DEFER_DOMAIN" in
        hotmail.com|outlook.com|live.com|msn.com)
            if   echo "$TOP_DEFER_ERROR" | grep -qiE 'CS01|IP reputation|block'; then
                DEFER_INTERPRETATION="IP com má reputação na Microsoft (SNDS). Acesse: https://sendersupport.olc.protection.outlook.com/snds/"
            elif echo "$TOP_DEFER_ERROR" | grep -qiE 'rate|limit|too many'; then
                DEFER_INTERPRETATION="Rate limiting da Microsoft — volume de envio alto para este IP."
            elif echo "$TOP_DEFER_ERROR" | grep -qiE 'SPF|DKIM|DMARC|authentication'; then
                DEFER_INTERPRETATION="Falha de autenticação (SPF/DKIM/DMARC) — verifique registros DNS."
            else
                DEFER_INTERPRETATION="Hotmail/Outlook bloqueando. Verifique reputação: https://sendersupport.olc.protection.outlook.com/snds/"
            fi ;;
        gmail.com|googlemail.com)
            DEFER_INTERPRETATION="Gmail bloqueando — verifique Postmaster Tools: https://postmaster.google.com" ;;
        yahoo.com|yahoo.com.br)
            DEFER_INTERPRETATION="Yahoo bloqueando — verifique: https://senders.yahooinc.com" ;;
        *)
            [ -n "$TOP_DEFER_DOMAIN" ] && \
                DEFER_INTERPRETATION="$TOP_DEFER_DOMAIN recusando temporariamente. Pode ser reputação, rate limit ou política local." ;;
    esac
}

# ============================================================
# ANÁLISE DE PHP MAILERS — versão leve para JSON (--json full)
# Não usa o modo interativo completo: apenas conta arquivos suspeitos
# com timeout para não bloquear o ciclo de 5 min do dashboard.
# Popula: PHP_MAILER_SUSPICIOUS, PHP_MAILER_MAIL_COUNT, PHP_MAILER_TOP_SUSPECT
# ============================================================
analyze_php_mailers_json() {
    PHP_MAILER_SUSPICIOUS=0
    PHP_MAILER_MAIL_COUNT=0
    PHP_MAILER_TOP_SUSPECT=""

    # Padrões de ofuscação / execução dinâmica
    local PAT_SUSPECT='base64_decode\s*\(|eval\s*\(|str_rot13\s*\(|gzinflate\s*\(|fsockopen.*25\b'
    local PAT_MAIL='mail\s*('

    # Raízes de busca: /srv/*/www → /srv/* → /var/www (máx 20 roots)
    local roots=()
    if [ -d /srv ]; then
        while IFS= read -r d; do
            if [ -d "${d}/www" ]; then
                roots+=("${d}/www")
            else
                roots+=("$d")
            fi
        done < <(find /srv -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | head -20)
    fi
    [ -d /var/www ] && roots+=("/var/www")

    # cPanel/WHM: cada conta vive em /home/<usuario>/, com o site em
    # public_html (às vezes "www" é symlink pra public_html). Usa o nome
    # da conta como identificador — não tenta mapear pra domínio, já que
    # uma conta cPanel pode ter vários domínios addon. Máx 20 contas.
    if [ -d /home ]; then
        while IFS= read -r acct; do
            local pub="${acct}/public_html" www="${acct}/www"
            [ -d "$pub" ] && roots+=("$pub")
            if [ -e "$www" ]; then
                # só adiciona "www" se não apontar pro mesmo lugar que
                # public_html (symlink comum) — evita escanear tudo em dobro
                if [ ! -d "$pub" ] || \
                   [ "$(readlink -f "$www" 2>/dev/null)" != "$(readlink -f "$pub" 2>/dev/null)" ]; then
                    roots+=("$www")
                fi
            fi
        done < <(find /home -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | head -20)
    fi

    for root in "${roots[@]}"; do
        [ -d "$root" ] || continue

        # Arquivos suspeitos — timeout de 10s por root para não travar
        local susp
        susp=$(timeout 10 find "$root" -name '*.php' -maxdepth 8 2>/dev/null \
            | xargs -r grep -lE "$PAT_SUSPECT" 2>/dev/null | head -5)
        local cnt; cnt=$(printf '%s\n' "$susp" | grep -c . 2>/dev/null); cnt=${cnt:-0}
        PHP_MAILER_SUSPICIOUS=$(( PHP_MAILER_SUSPICIOUS + cnt ))
        [ -z "$PHP_MAILER_TOP_SUSPECT" ] && \
            PHP_MAILER_TOP_SUSPECT=$(printf '%s\n' "$susp" | head -1)

        # Arquivos com mail() — timeout de 10s
        local mail_cnt
        mail_cnt=$(timeout 10 find "$root" -name '*.php' -maxdepth 8 2>/dev/null \
            | xargs -r grep -lE "$PAT_MAIL" 2>/dev/null | wc -l)
        PHP_MAILER_MAIL_COUNT=$(( PHP_MAILER_MAIL_COUNT + mail_cnt ))
    done

    # Escapa aspas para JSON seguro
    PHP_MAILER_TOP_SUSPECT=$(printf '%s' "$PHP_MAILER_TOP_SUSPECT" | sed 's/"/\\"/g')
}

# ============================================================
# ANÁLISE DE IDADE
# ============================================================
analyze_age() {
    OLD_DAYS=$(echo  "$QUEUE_RAW" | awk '$1~/^[0-9]+d$/{c++} END{print c+0}')
    OLD_HOURS=$(echo "$QUEUE_RAW" | awk '$1~/^[0-9]+h$/{c++} END{print c+0}')
    OLD_MINS=$(echo  "$QUEUE_RAW" | awk '$1~/^[0-9]+m$/{c++} END{print c+0}')

    # Coluna 2 de "exim -bp" traz o tamanho em bytes puro OU com sufixo
    # K/M/G (ex.: "443", "50K", "2.0M") — somar $2 direto sem converter
    # o sufixo (como o QUEUE_SIZE fazia antes) subestima em até ~1000x
    # pra mensagens grandes, porque awk trunca "50K" no prefixo numérico
    # "50" e ignora a unidade. to_bytes() abaixo corrige isso e também
    # alimenta a distribuição de tamanho usada no diagnóstico
    # FILA_MENSAGENS_GRANDES (classify()) e no bloco "queue" do JSON.
    local _size_stats
    _size_stats=$(echo "$QUEUE_RAW" | awk '
        function to_bytes(s,   n) {
            n = s + 0
            if (s ~ /G$/) return n * 1024 * 1024 * 1024
            if (s ~ /M$/) return n * 1024 * 1024
            if (s ~ /K$/) return n * 1024
            return n
        }
        $1 ~ /^[0-9]+[dhm]$/ {
            b = to_bytes($2)
            total_bytes += b
            if (b >= 1048576) over_1mb++
            if (b >= 5242880) over_5mb++
            if (b < 10240)    under_10kb++
        }
        END { printf "%.0f %d %d %d", total_bytes+0, over_1mb+0, over_5mb+0, under_10kb+0 }
    ')
    read -r _QUEUE_TOTAL_BYTES QSZ_OVER_1MB QSZ_OVER_5MB QSZ_UNDER_10KB <<< "$_size_stats"

    QUEUE_SIZE=$(awk -v b="${_QUEUE_TOTAL_BYTES:-0}" 'BEGIN{printf "%.1f", b/1024}' 2>/dev/null)
    [ -z "$QUEUE_SIZE" ] && QUEUE_SIZE="N/A"
}

# ============================================================
# CLASSIFICAÇÃO
# ============================================================
classify() {
    PROBLEM="NORMAL"; SEVERITY="OK"; PROBLEM_DESC="Fila operando normalmente"
    ACTIONS_RECOMMENDED=()

    # EXIM_CPU_TOTAL/EXIM_MEM_TOTAL são floats (soma de %CPU/%MEM de todos
    # os processos exim) — test -gt exige inteiro, então trunca na parte
    # decimal só para a comparação de threshold.
    local _exim_cpu_int="${EXIM_CPU_TOTAL%.*}"
    local _exim_mem_int="${EXIM_MEM_TOTAL%.*}"
    [ -z "$_exim_cpu_int" ] && _exim_cpu_int=0
    [ -z "$_exim_mem_int" ] && _exim_mem_int=0

    if   [ "$RELAY_SUSPECT_SEND" -gt "$TH_SPAM_RELAY_SEND" ] && \
         [ "$RELAY_SUSPECT_BOUNCE" -gt "$TH_SPAM_RELAY_BOUNCE" ]; then
        PROBLEM="SPAM_RELAY"; SEVERITY="CRITICAL"
        PROBLEM_DESC="Relay de spam — ${RELAY_SUSPECT} disparou e-mails usando este servidor"
        ACTIONS_RECOMMENDED=("clean-sender" "block-ip" "clean-frozen")

    elif [ "$TOP_SENDER_COUNT" -gt "$TH_SPAM_MASSIVO_SENDER" ] && \
         [ -n "$TOP_AUTH_USER" ] && \
         [ "${BOUNCE_COUNT:-0}" -lt 50 ] && \
         [ "${DEFER_COUNT:-0}" -gt 200 ]; then
        # Fila dominada por um único remetente autenticado com alto deferimento
        # e baixo bounce → envio legítimo em massa sendo throttled por provedores.
        local _top_sender_domain="${TOP_SENDER##*@}"
        local _auth_domain="${TOP_AUTH_USER##*@}"
        # Valida que o domínio do remetente bate com o do autenticado
        if [ "$_top_sender_domain" = "$_auth_domain" ] || \
           [ "${TOP_SENDER_COUNT:-0}" -gt 500 ]; then
            PROBLEM="ENVIO_THROTTLED"; SEVERITY="HIGH"
            PROBLEM_DESC="Envio em massa autenticado — $TOP_SENDER ($TOP_SENDER_COUNT msgs) sendo limitado por provedores"
            ACTIONS_RECOMMENDED=("retry-queue")
        else
            PROBLEM="SPAM_MASSIVO"; SEVERITY="CRITICAL"
            PROBLEM_DESC="Spam massivo — $TOP_SENDER ($TOP_SENDER_COUNT msgs na fila)"
            ACTIONS_RECOMMENDED=("clean-sender" "clean-frozen" "clean-full")
        fi

    elif [ "$QUEUE" -gt "$TH_SPAM_MASSIVO_QUEUE" ] && \
         [ "$RECENT_SENDS" -gt "$TH_SPAM_MASSIVO_SENDS" ] && \
         [ "$TOP_SENDER_COUNT" -gt "$TH_SPAM_MASSIVO_SENDER" ]; then
        PROBLEM="SPAM_MASSIVO"; SEVERITY="CRITICAL"
        PROBLEM_DESC="Spam massivo — $TOP_SENDER ($TOP_SENDER_COUNT msgs na fila)"
        ACTIONS_RECOMMENDED=("clean-sender" "clean-frozen" "clean-full")

    elif [ "$TOP_AUTH_COUNT" -gt "$TH_AUTH_ABUSE" ]; then
        PROBLEM="AUTH_ABUSE"; SEVERITY="CRITICAL"
        PROBLEM_DESC="Conta SMTP comprometida — $TOP_AUTH_USER ($TOP_AUTH_COUNT envios)"
        ACTIONS_RECOMMENDED=("clean-auth" "clean-sender")

    elif [ "$BOUNCE_COUNT" -gt "$TH_BOUNCE_CONCENTRADO" ] && \
         [ "$TOP_RECIPIENT_COUNT" -gt "$TH_BOUNCE_CONCENTRADO_RCPT" ]; then
        PROBLEM="BOUNCE_CONCENTRADO"; SEVERITY="HIGH"
        PROBLEM_DESC="Bounce storm — $BOUNCE_COUNT bounces, $TOP_RECIPIENT_COUNT msgs para $TOP_RECIPIENT"
        ACTIONS_RECOMMENDED=("clean-bounces" "retry-queue")

    elif [ "$TOP_IP_COUNT" -gt "$TH_IP_FLOOD" ]; then
        PROBLEM="IP_FLOOD"; SEVERITY="HIGH"
        PROBLEM_DESC="Flood por IP externo — $TOP_IP ($TOP_IP_COUNT conexões)"
        ACTIONS_RECOMMENDED=("block-ip")

    elif [ "$OLD_DAYS" -gt "$TH_FILA_TRAVADA_DAYS" ] || \
         [ "$FROZEN_COUNT" -gt "$TH_FILA_TRAVADA_FROZEN" ]; then
        PROBLEM="FILA_TRAVADA"; SEVERITY="HIGH"
        PROBLEM_DESC="Fila travada — $OLD_DAYS msgs >1 dia, $FROZEN_COUNT frozen"
        ACTIONS_RECOMMENDED=("clean-frozen" "retry-queue")

    elif [ "$DEFER_COUNT" -gt "$TH_ALTO_DEFERIMENTO" ]; then
        PROBLEM="ALTO_DEFERIMENTO"; SEVERITY="MEDIUM"
        PROBLEM_DESC="Alto deferimento ($DEFER_COUNT) — destinos bloqueando entregas"
        ACTIONS_RECOMMENDED=("retry-queue")

    elif [ "$BOUNCE_COUNT" -gt "$TH_BOUNCE_STORM" ] || \
         [ "$BOUNCE_LOG_COUNT" -gt "$TH_BOUNCE_STORM" ]; then
        PROBLEM="BOUNCE_STORM"; SEVERITY="MEDIUM"
        PROBLEM_DESC="Storm de bounces — $BOUNCE_COUNT bounces na fila"
        ACTIONS_RECOMMENDED=("clean-bounces" "retry-queue")

    elif [ "$REJECT_COUNT" -gt "$TH_ALTA_REJEICAO" ]; then
        PROBLEM="ALTA_REJEICAO"; SEVERITY="MEDIUM"
        PROBLEM_DESC="Alta taxa de rejeição — $REJECT_COUNT rejeições"
        ACTIONS_RECOMMENDED=("retry-queue")

    elif [ "${_exim_cpu_int:-0}" -gt "$TH_CPU_PCT" ] || [ "${_exim_mem_int:-0}" -gt "$TH_MEM_PCT" ]; then
        # Sem ação de um clique de propósito — reiniciar o daemon é arriscado
        # demais pra ser self-service; recomendação fica só textual.
        PROBLEM="ALTO_CONSUMO_RECURSOS"; SEVERITY="MEDIUM"
        PROBLEM_DESC="Alto consumo de recursos pelo Exim — CPU ${EXIM_CPU_TOTAL:-0}%, MEM ${EXIM_MEM_TOTAL:-0}% (investigar manualmente antes de reiniciar o daemon)"
        ACTIONS_RECOMMENDED=()

    elif [ "${TLD_SUSPEITA_COUNT:-0}" -gt "$TH_TLD_SUSPEITA" ]; then
        PROBLEM="TLD_SUSPEITA"; SEVERITY="MEDIUM"
        PROBLEM_DESC="$TLD_SUSPEITA_COUNT envios para TLDs de alto risco — revisar conta de origem"
        ACTIONS_RECOMMENDED=()

    elif [ "${QSZ_OVER_5MB:-0}" -ge "$TH_QUEUE_MSGS_GRANDES" ] && \
         [ "${QUEUE:-0}" -gt 0 ] && \
         [ $(( QSZ_OVER_5MB * 100 / QUEUE )) -ge 50 ]; then
        # Só dispara quando mensagens >5MB são a MAIORIA da fila (não só
        # "presentes" em meio a milhares de pequenas — isso já é coberto
        # por SPAM_MASSIVO/FILA_ALTA) — sinal específico de "poucas
        # mensagens gigantes" (anexo pesado, backup por engano etc.)
        # dominando o tempo de entrega, não spam/flood.
        PROBLEM="FILA_MENSAGENS_GRANDES"; SEVERITY="MEDIUM"
        PROBLEM_DESC="$QSZ_OVER_5MB de $QUEUE mensagens na fila são >5MB — poucas mensagens gigantes podem estar dominando o tempo de entrega"
        ACTIONS_RECOMMENDED=("retry-queue")

    elif [ "$QUEUE" -gt "$TH_FILA_ALTA" ]; then
        PROBLEM="FILA_ALTA"; SEVERITY="LOW"
        PROBLEM_DESC="Fila elevada sem causa óbvia — investigar"
        ACTIONS_RECOMMENDED=("retry-queue")
    fi
}

# ============================================================
# HELPER — converte lista "  N domain" para array JSON
# Entrada: variável multi-linha tipo "  5 gmail.com\n  3 yahoo.com"
# Saída:   [{"domain":"gmail.com","count":5},...]
# ============================================================
_domains_to_json() {
    local raw="$1" out="" first=1 cnt dom
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        cnt=$(echo "$line" | awk '{print $1}')
        dom=$(echo "$line" | awk '{print $2}')
        [ -z "$dom" ] && continue
        dom=$(printf '%s' "$dom" | sed 's/"/\\"/g')
        [ "$first" -eq 0 ] && out="${out},"
        out="${out}{\"domain\":\"${dom}\",\"count\":${cnt}}"
        first=0
    done <<< "$raw"
    printf '[%s]' "$out"
}

# ============================================================
# MODO --check: AUTODIAGNÓSTICO DO SERVIDOR (T2-3)
# Verifica pré-requisitos e retorna JSON {"ok":bool,"checks":[]}.
# Chamado pelo backend ao cadastrar um novo servidor.
# ============================================================
run_check() {
    local _ok="true"
    local _checks=""

    # ── Check 1: binário exim ─────────────────────────────────────
    local _eb_ok="true" _eb_msg
    if [ -z "$EXIM_BIN" ]; then
        _eb_ok="false"; _ok="false"
        _eb_msg="exim/exim4 nao encontrado no PATH"
    else
        _eb_msg="OK — binario: $EXIM_BIN"
    fi
    _checks="${_checks}{\"check\":\"exim_binary\",\"ok\":${_eb_ok},\"detail\":\"${_eb_msg}\"},"

    # ── Check 2: exiqgrep ─────────────────────────────────────────
    local _eq_ok="true" _eq_msg="OK — exiqgrep disponivel"
    command -v exiqgrep &>/dev/null || { _eq_ok="false"; _eq_msg="exiqgrep nao encontrado — acoes frozen/bounce limitadas"; }
    _checks="${_checks}{\"check\":\"exiqgrep\",\"ok\":${_eq_ok},\"detail\":\"${_eq_msg}\"},"

    # ── Check 3: espaço em disco (alerta se >=90% usado) ─────────
    local _disk_ok="true" _disk_msg _disk_use
    _disk_use=$(df / 2>/dev/null | awk 'NR==2{gsub(/%/,""); print $5}')
    if [ -n "$_disk_use" ] && [ "$_disk_use" -ge 90 ]; then
        _disk_ok="false"; _ok="false"
        _disk_msg="ATENCAO: disco com ${_disk_use}% usado (menos de 10% livre)"
    else
        _disk_msg="OK — disco com ${_disk_use:-?}% usado"
    fi
    _checks="${_checks}{\"check\":\"disk_space\",\"ok\":${_disk_ok},\"detail\":\"${_disk_msg}\"},"

    # ── Check 4: mainlog acessível ────────────────────────────────
    local _log_ok="true" _log_msg _log_found=""
    for _lc in "${LOG_CANDIDATES[@]}"; do
        [ -r "$_lc" ] && { _log_found="$_lc"; break; }
    done
    if [ -z "$_log_found" ]; then
        _log_ok="false"; _ok="false"
        _log_msg="Mainlog nao encontrado ou inacessivel"
    else
        _log_msg="OK — $( printf '%s' "$_log_found" | sed 's/\//\\\//g' )"
    fi
    _checks="${_checks}{\"check\":\"mainlog\",\"ok\":${_log_ok},\"detail\":\"${_log_msg}\"},"

    # ── Check 5: ambiente cPanel/WHM ─────────────────────────────
    # Informativo — nao afeta _ok. Usado por acoes futuras (ex.: block-ip
    # via CSF) para escolher o comando certo por ambiente.
    local _cpanel_ok="false" _cpanel_msg="cPanel/WHM nao detectado"
    if [ -d /usr/local/cpanel ]; then
        _cpanel_ok="true"
        _cpanel_msg="OK — /usr/local/cpanel presente"
    fi
    _checks="${_checks}{\"check\":\"cpanel\",\"ok\":${_cpanel_ok},\"detail\":\"${_cpanel_msg}\"},"

    # ── Check 6: firewall CSF (ConfigServer Firewall) ────────────
    # Informativo — nao afeta _ok. CSF e o firewall de fato mais comum
    # em ambientes cPanel; sua ausencia so importa quando block-ip
    # tentar usa-lo (fora do escopo deste item).
    local _csf_ok="false" _csf_msg="CSF nao encontrado no PATH ($EXIM_CSF_BIN)"
    if command -v "$EXIM_CSF_BIN" &>/dev/null; then
        _csf_ok="true"
        _csf_msg="OK — $EXIM_CSF_BIN disponivel"
    fi
    _checks="${_checks}{\"check\":\"csf\",\"ok\":${_csf_ok},\"detail\":\"${_csf_msg}\"},"

    # ── Check 7: Imunify360 ───────────────────────────────────────
    # Informativo — nao afeta _ok. Usado por check-ip-status/unblock-ip.
    local _imun_ok="false" _imun_msg="Imunify360 nao encontrado no PATH ($EXIM_IMUNIFY_BIN)"
    if command -v "$EXIM_IMUNIFY_BIN" &>/dev/null; then
        _imun_ok="true"
        _imun_msg="OK — $EXIM_IMUNIFY_BIN disponivel"
    fi
    _checks="${_checks}{\"check\":\"imunify360\",\"ok\":${_imun_ok},\"detail\":\"${_imun_msg}\"},"

    # ── Check 8: relay aberto ───────────────────────────────────────
    # Informativo — nao afeta _ok (mesmo padrao de cpanel/csf/imunify360).
    # "exim -bP config" imprime a configuracao ja expandida (funciona tanto
    # no layout Debian/split-config quanto no exim.conf monolitico do
    # cPanel) — evita depender de um nome de opcao especifico que pode nao
    # existir em todo layout (ex.: "-bP relay_from_hosts" direto falha no
    # Debian, que define isso via "hostlist"). So sinaliza problema quando
    # acha um padrao INEQUIVOCO de host coringa (*, 0.0.0.0/0, ::/0) — sem
    # esse padrao, fica "OK" com a nota de revisar manualmente, pra nao dar
    # falso positivo tentando interpretar ACL customizada de cada cliente.
    local _relay_ok="true" _relay_msg _relay_cfg _relay_val
    _relay_cfg=$(timeout 10 $SUDO "$EXIM_BIN" -bP config 2>/dev/null)
    if [ -z "$_relay_cfg" ]; then
        _relay_msg="Nao foi possivel ler a configuracao (exim -bP config sem permissao ou vazio) — revisar manualmente"
    else
        _relay_val=$(printf '%s\n' "$_relay_cfg" \
            | grep -m1 -iE '^[[:space:]]*(hostlist[[:space:]]+)?relay_from_hosts[[:space:]]*=' \
            | sed -E 's/^[^=]*=[[:space:]]*//')
        if printf '%s' "$_relay_val" | grep -qE '(^|[^0-9.:])(\*|0\.0\.0\.0/0|::/0)([^0-9.]|$)'; then
            _relay_ok="false"
            _relay_msg="relay_from_hosts permite qualquer host (\\\"${_relay_val}\\\") — possivel relay aberto, revisar ACL de relay"
        elif [ -z "$_relay_val" ]; then
            _relay_msg="relay_from_hosts nao encontrado/vazio na config expandida — revisar manualmente se a ACL controla relay por outro mecanismo"
        else
            _relay_msg="OK — relay_from_hosts restrito (${_relay_val})"
        fi
    fi
    _checks="${_checks}{\"check\":\"open_relay\",\"ok\":${_relay_ok},\"detail\":\"${_relay_msg}\"},"

    # ── Check 9: STARTTLS na porta 25 ────────────────────────────────
    # Informativo — nao afeta _ok. So falha (ok:false) se STARTTLS nem
    # estiver sendo OFERECIDO — nao forcar STARTTLS obrigatorio em SMTP
    # publico na porta 25 e esperado/normal (senders legados sem TLS
    # perderiam a entrega), entao "nao obrigatorio" em si e reportado como
    # nota informativa, nao como falha.
    local _tls_ok="true" _tls_msg _tls_adv
    _tls_adv=$(timeout 10 "$EXIM_BIN" -bP tls_advertise_hosts 2>/dev/null | sed -E 's/^[^=]*=[[:space:]]*//')
    if [ -z "$_tls_adv" ]; then
        _tls_ok="false"
        _tls_msg="tls_advertise_hosts vazio — STARTTLS nao esta sendo oferecido na porta 25"
    else
        _tls_msg="STARTTLS oferecido (tls_advertise_hosts=${_tls_adv}) — nao obrigatorio por padrao, o que e esperado num MX publico (forcar quebraria entrega de remetentes sem TLS)"
    fi
    _checks="${_checks}{\"check\":\"starttls\",\"ok\":${_tls_ok},\"detail\":\"${_tls_msg}\"},"

    # ── Check 10: versao do Exim vs. CVEs criticos conhecidos ────────
    # Informativo — nao afeta _ok. ATENCAO: lista pequena, mantida À MÃO
    # abaixo — NAO e uma feed ao vivo (tipo OSV/NVD), so cobre um punhado
    # de CVEs criticos (RCE) bem conhecidos como referencia rapida. Precisa
    # de revisao manual periodica pra continuar util; versao aprovada aqui
    # NAO significa ausencia de CVEs mais recentes nao listados.
    #   - CVE-2019-10149 ("Return of the WIZard", RCE) — Exim 4.87-4.91,
    #     corrigido na 4.92.
    #   - "21Nails" (CVE-2020-28007 a CVE-2020-28026 + CVE-2021-27216,
    #     RCE/escalada de privilegio local) — Exim < 4.94.2.
    detect_exim_version
    # Comparacao estrita A<B via sort -V (nao -VC direto contra o threshold,
    # que e <=  — isso classificaria a propria versao corrigida, ex. 4.94.2
    # exata, como "vulneravel" por um off-by-one).
    _ver_lt() { [ "$1" != "$2" ] && printf '%s\n%s\n' "$1" "$2" | sort -VC 2>/dev/null; }

    local _cve_ok="true" _cve_msg
    if [ "$EXIM_VER_STR" = "unknown" ]; then
        _cve_msg="Nao foi possivel determinar a versao do Exim"
    elif _ver_lt "$EXIM_VER_STR" "4.92"; then
        _cve_ok="false"
        _cve_msg="Exim ${EXIM_VER_STR} — anterior a 4.92: vulneravel a CVE-2019-10149 (RCE) e ao pacote 21Nails — atualizar com urgencia"
    elif _ver_lt "$EXIM_VER_STR" "4.94.2"; then
        _cve_ok="false"
        _cve_msg="Exim ${EXIM_VER_STR} — anterior a 4.94.2: vulneravel ao pacote 21Nails (CVE-2020-28007 a CVE-2021-27216) — atualizar"
    else
        _cve_msg="OK — Exim ${EXIM_VER_STR} sem CVE critico conhecido nesta lista curta (revisar periodicamente contra fontes atualizadas)"
    fi
    _checks="${_checks}{\"check\":\"exim_version_cve\",\"ok\":${_cve_ok},\"detail\":\"${_cve_msg}\"}"

    printf '{\n'
    printf '  "timestamp": "%s",\n' "$DATE_ISO"
    printf '  "hostname": "%s",\n' "$HOSTNAME"
    printf '  "script_version": "%s",\n' "$VERSION"
    printf '  "ok": %s,\n' "$_ok"
    printf '  "checks": [%s]\n' "$_checks"
    printf '}\n'
}

# ============================================================
# SAÍDA JSON
# ============================================================
output_json() {
    local _mode="full"
    [ "$QUICK_MODE" -eq 1 ] && _mode="quick"

    # Arrays JSON reutilizados em ambos os modos
    local _rejected_json _defer_json _ar_json=""
    _rejected_json=$(_domains_to_json "$TOP_REJECTED_DOMAINS")
    _defer_json=$(_domains_to_json "$TOP_DEFER_DOMAINS")
    for _a in "${ACTIONS_RECOMMENDED[@]:-}"; do
        [ -z "$_a" ] && continue
        [ -n "$_ar_json" ] && _ar_json="${_ar_json},"
        _ar_json="${_ar_json}\"${_a}\""
    done

    if [ "$QUICK_MODE" -eq 1 ]; then
        # Modo quick: métricas do log + contagem de fila + hourly_stats.
        # Campos dependentes de exim -bp são omitidos (não coletados).

        # Monta array JSON de hourly_stats
        local _hs_json="" _i
        for _i in "${!HOURLY_HOURS[@]}"; do
            [ -n "$_hs_json" ] && _hs_json="${_hs_json},"
            _hs_json="${_hs_json}{\"hour\":\"${HOURLY_HOURS[$_i]}\",\"recv\":${HOURLY_RECV[$_i]:-0},\"sent\":${HOURLY_SENT[$_i]:-0}}"
        done

        # T2-2: campo error; T2-1: collect_timed_out
        local _err_esc _timed_out_str="false"
        _err_esc=$(printf '%s' "${COLLECT_ERROR:-}" | sed 's/"/\\"/g; s/\//\\\//g')
        [ "${COLLECT_TIMED_OUT:-0}" -eq 1 ] && _timed_out_str="true"

        printf '{\n'
        printf '  "timestamp": "%s",\n' "$DATE_ISO"
        printf '  "hostname": "%s",\n' "$HOSTNAME"
        printf '  "script_version": "%s",\n' "$VERSION"
        printf '  "version": "%s",\n' "$VERSION"
        printf '  "mode": "%s",\n' "$_mode"
        printf '  "profile": "%s",\n' "${PROFILE:-standard}"
        printf '  "collect_timed_out": %s,\n' "$_timed_out_str"
        [ -n "$_err_esc" ] && printf '  "error": "%s",\n' "$_err_esc"
        printf '  "queue": { "total": %s, "frozen": %s },\n' "${QUEUE:-0}" "${FROZEN_COUNT:-0}"
        printf '  "log": {\n'
        printf '    "delivered": %s, "rejected": %s, "deferred": %s,\n'             "${DELIVERED_COUNT:-0}" "${REJECT_COUNT:-0}" "${DEFER_COUNT:-0}"
        printf '    "recent_sends": %s, "dns_errors": %s,\n'             "${RECENT_SENDS:-0}" "${DNS_ERRORS:-0}"
        printf '    "mainlog_size_mb": %s\n' "${MAINLOG_SIZE_MB:-0}"
        printf '  },\n'
        printf '  "hourly_stats": [%s],\n' "$_hs_json"
        printf '  "top_auth_user": "%s", "top_auth_count": %s,\n'             "$TOP_AUTH_USER" "${TOP_AUTH_COUNT:-0}"
        printf '  "top_ip": "%s", "top_ip_count": %s,\n'             "$TOP_IP" "${TOP_IP_COUNT:-0}"
        printf '  "top_rejected_domains": %s,\n' "$_rejected_json"
        printf '  "top_defer_domains": %s,\n' "$_defer_json"
        printf '  "diagnosis": {\n'
        printf '    "problem": "%s", "severity": "%s",\n' "$PROBLEM" "$SEVERITY"
        printf '    "description": "%s",\n' "$PROBLEM_DESC"
        printf '    "actions_recommended": [%s]\n' "$_ar_json"
        printf '  },\n'
        printf '  "exim": { "processes": %s, "uptime": "%s", "version": "%s", "cpu_total": %s, "mem_total": %s, "top_processes": %s }\n' \
            "${EXIM_PROCS:-0}" "$EXIM_UPTIME" "$EXIM_VER_STR" "${EXIM_CPU_TOTAL:-0}" "${EXIM_MEM_TOTAL:-0}" "${EXIM_TOP_PROC_JSON:-[]}"
        printf '}\n'
        return
    fi

    # Modo full: saída completa com todos os campos.
    # T2-2: campo error; T2-1: collect_timed_out; T2-4: script_version; T2-5: mainlog_size_mb
    local _err_esc _timed_out_str="false"
    _err_esc=$(printf '%s' "${COLLECT_ERROR:-}" | sed 's/"/\\"/g; s/\//\\\//g')
    [ "${COLLECT_TIMED_OUT:-0}" -eq 1 ] && _timed_out_str="true"

    printf '{\n'
    printf '  "timestamp": "%s",\n' "$DATE_ISO"
    printf '  "hostname": "%s",\n' "$HOSTNAME"
    printf '  "script_version": "%s",\n' "$VERSION"
    printf '  "version": "%s",\n' "$VERSION"
    printf '  "mode": "%s",\n' "$_mode"
    printf '  "profile": "%s",\n' "${PROFILE:-standard}"
    printf '  "collect_timed_out": %s,\n' "$_timed_out_str"
    [ -n "$_err_esc" ] && printf '  "error": "%s",\n' "$_err_esc"
    printf '  "queue": {\n'
    printf '    "total": %s, "frozen": %s, "bounces": %s,\n'         "${QUEUE:-0}" "${FROZEN_COUNT:-0}" "${BOUNCE_COUNT:-0}"
    printf '    "size_kb": "%s",\n' "${QUEUE_SIZE:-N/A}"
    printf '    "size_distribution": { "over_1mb": %s, "over_5mb": %s, "under_10kb": %s, "sampled": %s },\n' \
        "${QSZ_OVER_1MB:-0}" "${QSZ_OVER_5MB:-0}" "${QSZ_UNDER_10KB:-0}" "$([ "${QUEUE_SAMPLED:-0}" -eq 1 ] && echo true || echo false)"
    printf '    "age": { "days": %s, "hours": %s, "minutes": %s }\n'         "${OLD_DAYS:-0}" "${OLD_HOURS:-0}" "${OLD_MINS:-0}"
    printf '  },\n'
    printf '  "log": {\n'
    printf '    "delivered": %s, "rejected": %s, "deferred": %s,\n'         "${DELIVERED_COUNT:-0}" "${REJECT_COUNT:-0}" "${DEFER_COUNT:-0}"
    printf '    "recent_sends": %s, "dns_errors": %s,\n'         "${RECENT_SENDS:-0}" "${DNS_ERRORS:-0}"
    printf '    "mainlog_size_mb": %s\n' "${MAINLOG_SIZE_MB:-0}"
    printf '  },\n'
    printf '  "top_sender": "%s", "top_sender_count": %s,\n'         "$TOP_SENDER" "${TOP_SENDER_COUNT:-0}"
    printf '  "top_auth_user": "%s", "top_auth_count": %s,\n'         "$TOP_AUTH_USER" "${TOP_AUTH_COUNT:-0}"
    printf '  "top_ip": "%s", "top_ip_count": %s,\n'         "$TOP_IP" "${TOP_IP_COUNT:-0}"
    printf '  "top_recipient": "%s", "top_recipient_count": %s,\n'         "$TOP_RECIPIENT" "${TOP_RECIPIENT_COUNT:-0}"
    printf '  "relay_suspect": "%s", "relay_suspect_send": %s, "relay_suspect_bounce": %s,\n'         "$RELAY_SUSPECT" "${RELAY_SUSPECT_SEND:-0}" "${RELAY_SUSPECT_BOUNCE:-0}"
    printf '  "top_rejected_domains": %s,\n' "$_rejected_json"
    printf '  "top_defer_domains": %s,\n' "$_defer_json"
    printf '  "php_mailers": {\n'
    printf '    "suspicious": %s, "mail_calls": %s,\n'         "${PHP_MAILER_SUSPICIOUS:-0}" "${PHP_MAILER_MAIL_COUNT:-0}"
    printf '    "top_suspect": "%s"\n' "$PHP_MAILER_TOP_SUSPECT"
    printf '  },\n'
    printf '  "diagnosis": {\n'
    printf '    "problem": "%s", "severity": "%s",\n' "$PROBLEM" "$SEVERITY"
    printf '    "description": "%s",\n' "$PROBLEM_DESC"
    printf '    "actions_recommended": [%s]\n' "$_ar_json"
    printf '  },\n'
    printf '  "exim": { "processes": %s, "uptime": "%s", "version": "%s", "cpu_total": %s, "mem_total": %s, "top_processes": %s }\n' \
        "${EXIM_PROCS:-0}" "$EXIM_UPTIME" "$EXIM_VER_STR" "${EXIM_CPU_TOTAL:-0}" "${EXIM_MEM_TOTAL:-0}" "${EXIM_TOP_PROC_JSON:-[]}"
    printf '}\n'
}

# ============================================================
# SAÍDA JSON — AÇÃO
# Retorna {"success":bool,"action":"...","message":"..."}
# Usado pelo modo --action= para respostas de API REST.
# ============================================================
output_action_json() {
    local success="$1" action="$2" message="$3" extra_json="$4"
    _audit_log "$action" "$ACTION_PARAM" "$success" "$message"
    message=$(printf '%s' "$message" | sed 's/"/\\"/g')
    printf '{\n'
    printf '  "timestamp": "%s",\n' "$DATE_ISO"
    printf '  "hostname": "%s",\n' "$HOSTNAME"
    printf '  "script_version": "%s",\n' "$VERSION"
    printf '  "version": "%s",\n' "$VERSION"
    printf '  "success": %s,\n' "$success"
    printf '  "action": "%s",\n' "$action"
    printf '  "actor": "%s",\n' "${ACTOR_NAME:-system}"
    printf '  "message": "%s"%s\n' "$message" "${extra_json:+,}"
    [ -n "$extra_json" ] && printf '  %s\n' "$extra_json"
    printf '}\n'
}

# ============================================================
# T3-3 — LOG DE AUDITORIA DE AÇÕES
# Registra cada ação executada em /var/log/exim-monitor/actions.log
# com timestamp, actor, ação e resultado.
# ============================================================
_audit_log() {
    local action="$1" param="$2" success="$3" message="$4"
    local log_dir="/var/log/exim-monitor"
    local log_file="$log_dir/actions.log"
    # Cria diretório se não existir
    [ -d "$log_dir" ] || { $SUDO mkdir -p "$log_dir" 2>/dev/null; $SUDO chmod 750 "$log_dir" 2>/dev/null; }
    local actor_str="${ACTOR_NAME:-system}"
    local param_str="${param:+ param=$param}"
    local entry
    entry=$(printf '[%s] actor=%s action=%s%s success=%s msg=%s
'         "$DATE" "$actor_str" "$action" "$param_str" "$success" "$message")
    printf '%s
' "$entry" | $SUDO tee -a "$log_file" >/dev/null 2>&1 || true
}

# ============================================================
# VALIDAÇÃO DE PARÂMETROS DE AÇÃO
# Aceita apenas caracteres seguros — rejeita metacaracteres de shell
# que poderiam causar injeção de comando via API REST.
# ============================================================
_validate_action_param() {
    local val="$1"
    [ -z "$val" ] && return 1
    printf '%s' "$val" | grep -qE '^[a-zA-Z0-9._%+@_-]+$'
}

# ============================================================
# SNAPSHOT "ANTES" DE AÇÕES DESTRUTIVAS
# Converte uma lista de IDs (uma por linha, já filtrados pelo padrão
# alfanumérico de Message-ID do Exim — ver os grep -E '^[A-Za-z0-9-]{6,}$'
# usados antes de montar essas listas) num array JSON de strings. Usado
# por execute_action() para compor "before_snapshot" — visibilidade de
# reversibilidade real na auditoria, não é undo de verdade (mensagens
# removidas continuam removidas), só registra o que existia antes.
# ============================================================
_json_id_array() {
    local ids="$1" out="" first=1 id
    while IFS= read -r id; do
        [ -z "$id" ] && continue
        [ "$first" -eq 1 ] || out="${out},"
        out="${out}\"${id}\""
        first=0
    done <<< "$ids"
    printf '%s' "$out"
}

# ============================================================
# EXECUTOR DE AÇÕES — modo --action=
# Despacha para a função de limpeza/bloqueio correspondente
# e emite JSON de resultado. Não requer análise prévia.
# ============================================================
execute_action() {
    local cmd="$1" param="$2"

    # Precisa de exim disponível para qualquer ação
    [ -z "$EXIM_BIN" ] && {
        output_action_json "false" "$cmd" "exim/exim4 não encontrado no PATH"
        exit 1
    }

    case "$cmd" in

        clean-full)
            local count; count=$("$EXIM_BIN" -bpc 2>/dev/null || echo 0)
            local ids; ids=$(timeout "$GLOBAL_TIMEOUT" "$EXIM_BIN" -bp 2>/dev/null \
                | awk '{print $3}' | grep -E '^[A-Za-z0-9-]{6,}$')
            local _before=""
            [ "$SNAPSHOT_MODE" = "1" ] && _before="\"before_snapshot\": {\"queue_total\": ${count:-0}, \"sample_ids\": [$(_json_id_array "$(echo "$ids" | head -"$SNAPSHOT_SAMPLE_LIMIT")")]}"
            echo "$ids" | xargs -r -P4 "$EXIM_BIN" -Mrm >/dev/null 2>&1
            output_action_json "true" "$cmd" \
                "Fila limpa — $count mensagens removidas" "$_before"
            ;;

        clean-frozen)
            local ids; ids=$(exiqgrep -z -i 2>/dev/null \
                | grep -E '^[A-Za-z0-9-]{6,}$')
            local count; count=$(echo "$ids" | grep -c . 2>/dev/null); count=${count:-0}
            local _before=""
            [ "$SNAPSHOT_MODE" = "1" ] && _before="\"before_snapshot\": {\"frozen_count\": ${count}, \"sample_ids\": [$(_json_id_array "$(echo "$ids" | head -"$SNAPSHOT_SAMPLE_LIMIT")")]}"
            echo "$ids" | xargs -r -P4 "$EXIM_BIN" -Mrm >/dev/null 2>&1
            output_action_json "true" "$cmd" \
                "$count mensagens frozen removidas" "$_before"
            ;;

        clean-bounces)
            local ids; ids=$($SUDO exiqgrep -f '<>' -i 2>/dev/null \
                | grep -E '^[A-Za-z0-9-]{6,}$')
            local count; count=$(echo "$ids" | grep -c . 2>/dev/null); count=${count:-0}
            local _before=""
            [ "$SNAPSHOT_MODE" = "1" ] && _before="\"before_snapshot\": {\"bounce_count\": ${count}, \"sample_ids\": [$(_json_id_array "$(echo "$ids" | head -"$SNAPSHOT_SAMPLE_LIMIT")")]}"
            echo "$ids" | xargs -r -P4 "$EXIM_BIN" -Mrm >/dev/null 2>&1
            output_action_json "true" "$cmd" \
                "$count bounces (<>) removidos" "$_before"
            ;;

        clean-sender)
            if [ -z "$param" ]; then
                output_action_json "false" "$cmd" \
                    "Parâmetro obrigatório: --action=clean-sender:<endereço>"
                exit 1
            fi
            if ! _validate_action_param "$param"; then
                output_action_json "false" "$cmd" \
                    "Parâmetro inválido: '$param' contém caracteres não permitidos"
                exit 1
            fi
            local ids; ids=$($SUDO exiqgrep -f "$param" -i 2>/dev/null \
                | grep -E '^[A-Za-z0-9-]{6,}$')
            local count; count=$(echo "$ids" | grep -c . 2>/dev/null); count=${count:-0}
            local _before=""
            [ "$SNAPSHOT_MODE" = "1" ] && _before="\"before_snapshot\": {\"count\": ${count}, \"sender\": \"${param}\", \"sample_ids\": [$(_json_id_array "$(echo "$ids" | head -"$SNAPSHOT_SAMPLE_LIMIT")")]}"
            echo "$ids" | xargs -r -P4 "$EXIM_BIN" -Mrm >/dev/null 2>&1
            output_action_json "true" "$cmd" \
                "$count mensagens de '$param' removidas" "$_before"
            ;;

        clean-auth)
            if [ -z "$param" ]; then
                output_action_json "false" "$cmd" \
                    "Parâmetro obrigatório: --action=clean-auth:<usuário>"
                exit 1
            fi
            if ! _validate_action_param "$param"; then
                output_action_json "false" "$cmd" \
                    "Parâmetro inválido: '$param' contém caracteres não permitidos"
                exit 1
            fi
            local removed=0 _match_ids=""
            for mid in $(exiqgrep -f "" -i 2>/dev/null | head -500); do
                "$EXIM_BIN" -Mvh "$mid" 2>/dev/null | grep -q "auth_id.*${param}" \
                    && { _match_ids="${_match_ids}${mid}"$'\n'; removed=$((removed+1)); }
            done
            local _before=""
            [ "$SNAPSHOT_MODE" = "1" ] && _before="\"before_snapshot\": {\"count\": ${removed}, \"auth_user\": \"${param}\", \"sample_ids\": [$(_json_id_array "$(printf '%s' "$_match_ids" | head -"$SNAPSHOT_SAMPLE_LIMIT")")]}"
            printf '%s' "$_match_ids" | xargs -r "$EXIM_BIN" -Mrm >/dev/null 2>&1
            output_action_json "true" "$cmd" \
                "$removed mensagens do usuário '$param' removidas" "$_before"
            ;;

        block-ip)
            if [ -z "$param" ]; then
                output_action_json "false" "$cmd" \
                    "Parâmetro obrigatório: --action=block-ip:<ip>"
                exit 1
            fi
            # T3-1: Validação IPv4 e IPv6
            local _ip_valid=0
            echo "$param" | grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$' && _ip_valid=1
            echo "$param" | grep -qE '^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$' && _ip_valid=1
            if [ "$_ip_valid" -eq 0 ]; then
                output_action_json "false" "$cmd" \
                    "Endereço IP inválido: '$param' (esperado IPv4 ou IPv6)"
                exit 1
            fi
            local _result_msgs=""
            # T3-1: Bloquear via iptables imediatamente — só a ação via
            # API faz isso; o menu interativo confia no restart do
            # firewall.service dentro de _block_ip_persist pra aplicar.
            # >/dev/null (não só 2>/dev/null): algumas builds de iptables
            # imprimem a regra encontrada em stdout mesmo em -C (check),
            # o que contaminaria o JSON de saída com uma linha extra
            local _already_iptables=0
            $SUDO iptables -C INPUT -s "$param" -j DROP >/dev/null 2>&1 && _already_iptables=1
            local _already_persisted=0
            [ -f /etc/firewall.d/03_custom ] && grep -qF "$param" /etc/firewall.d/03_custom 2>/dev/null && _already_persisted=1
            local _before=""
            if [ "$SNAPSHOT_MODE" = "1" ]; then
                _before="\"before_snapshot\": {\"already_blocked_iptables\": $([ "$_already_iptables" -eq 1 ] && printf true || printf false), \"already_persisted\": $([ "$_already_persisted" -eq 1 ] && printf true || printf false)}"
            fi
            if [ "$_already_iptables" -eq 1 ]; then
                _result_msgs="iptables: já bloqueado"
            else
                if $SUDO iptables -I INPUT -s "$param" -j DROP >/dev/null 2>&1; then
                    _result_msgs="iptables: bloqueado"
                else
                    _result_msgs="iptables: sem permissão"
                fi
            fi
            # Persistir em /etc/firewall.d/03_custom — lógica
            # compartilhada com o menu interativo (block_ip_firewall_d)
            local _persist_msg
            _persist_msg=$(_block_ip_persist "$param" "# Bloqueado via API em $DATE")
            output_action_json "true" "$cmd" \
                "IP $param processado — ${_result_msgs}; ${_persist_msg}" "$_before"
            ;;

        check-ip-status)
            if [ -z "$IP_PARAM" ]; then
                output_action_json "false" "$cmd" \
                    "Parâmetro obrigatório: --action=check-ip-status --ip=<ip>"
                exit 1
            fi
            local _ip_valid=0
            echo "$IP_PARAM" | grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$' && _ip_valid=1
            echo "$IP_PARAM" | grep -qE '^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$' && _ip_valid=1
            if [ "$_ip_valid" -eq 0 ]; then
                output_action_json "false" "$cmd" \
                    "Endereço IP inválido: '$IP_PARAM' (esperado IPv4 ou IPv6)"
                exit 1
            fi
            local _status_json; _status_json=$(check_ip_status_json "$IP_PARAM")
            output_action_json "true" "$cmd" \
                "Status de bloqueio verificado para $IP_PARAM" "$_status_json"
            ;;

        unblock-ip)
            if [ -z "$IP_PARAM" ] || [ -z "$TOOL_PARAM" ]; then
                output_action_json "false" "$cmd" \
                    "Parâmetros obrigatórios: --action=unblock-ip --ip=<ip> --tool=csf|imunify360"
                exit 1
            fi
            if ! _validate_action_param "$TOOL_PARAM"; then
                output_action_json "false" "$cmd" \
                    "Parâmetro inválido: tool='$TOOL_PARAM' contém caracteres não permitidos"
                exit 1
            fi
            local _ip_valid=0
            echo "$IP_PARAM" | grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$' && _ip_valid=1
            echo "$IP_PARAM" | grep -qE '^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$' && _ip_valid=1
            if [ "$_ip_valid" -eq 0 ]; then
                output_action_json "false" "$cmd" \
                    "Endereço IP inválido: '$IP_PARAM' (esperado IPv4 ou IPv6)"
                exit 1
            fi
            case "$TOOL_PARAM" in
                csf)
                    if ! command -v "$EXIM_CSF_BIN" &>/dev/null; then
                        output_action_json "false" "$cmd" \
                            "CSF não encontrado no PATH (binário: $EXIM_CSF_BIN — ajuste via EXIM_CSF_BIN se o caminho for outro)"
                        exit 1
                    fi
                    # Bloqueio temporário e permanente usam comandos diferentes
                    # (-tr vs -dr) — csf -t lista os temporários vigentes.
                    local _csf_out
                    if $SUDO "$EXIM_CSF_BIN" -t 2>/dev/null | grep -qF "$IP_PARAM"; then
                        _csf_out=$($SUDO "$EXIM_CSF_BIN" -tr "$IP_PARAM" 2>&1)
                    else
                        _csf_out=$($SUDO "$EXIM_CSF_BIN" -dr "$IP_PARAM" 2>&1)
                    fi
                    _csf_out=$(printf '%s' "$_csf_out" | tr '\n' ' ' | sed 's/"/\\"/g')
                    output_action_json "true" "$cmd" \
                        "CSF: $IP_PARAM desbloqueado — ${_csf_out}"
                    ;;
                imunify360)
                    if ! command -v "$EXIM_IMUNIFY_BIN" &>/dev/null; then
                        output_action_json "false" "$cmd" \
                            "Imunify360 não encontrado no PATH (binário: $EXIM_IMUNIFY_BIN — ajuste via EXIM_IMUNIFY_BIN se o caminho for outro)"
                        exit 1
                    fi
                    # Desbloqueio via whitelist (não remove da blacklist —
                    # confirmado como suficiente pelo cliente na call de demo)
                    local _imun_out
                    _imun_out=$($SUDO "$EXIM_IMUNIFY_BIN" ip-list local add --purpose white "$IP_PARAM" \
                        --comment "desbloqueado via Mail IQ" 2>&1)
                    _imun_out=$(printf '%s' "$_imun_out" | tr '\n' ' ' | sed 's/"/\\"/g')
                    output_action_json "true" "$cmd" \
                        "Imunify360: $IP_PARAM desbloqueado (whitelist) — ${_imun_out}"
                    ;;
                *)
                    output_action_json "false" "$cmd" \
                        "Tool desconhecida: '$TOOL_PARAM'. Opções: csf, imunify360"
                    exit 1
                    ;;
            esac
            ;;

        block-sender)
            # T3-2: Bloqueia remetente na blacklist do EXIM
            if [ -z "$param" ]; then
                output_action_json "false" "$cmd" \
                    "Parâmetro obrigatório: --action=block-sender:<endereço>"
                exit 1
            fi
            if ! _validate_action_param "$param"; then
                output_action_json "false" "$cmd" \
                    "Parâmetro inválido: '$param' contém caracteres não permitidos"
                exit 1
            fi
            # Valida formato de e-mail básico
            if ! echo "$param" | grep -qE '^[^@]+@[^@]+\.[^@]+$'; then
                output_action_json "false" "$cmd" \
                    "Endereço inválido: '$param' (esperado formato email@dominio.tld)"
                exit 1
            fi
            local exim_bl_s="/etc/exim4/spammer_sender"
            if [ -f "$exim_bl_s" ] && grep -qF "$param" "$exim_bl_s" 2>/dev/null; then
                output_action_json "false" "$cmd" \
                    "Remetente $param já está na blacklist ($exim_bl_s)"
                exit 0
            fi
            local _before=""
            [ "$SNAPSHOT_MODE" = "1" ] && _before="\"before_snapshot\": {\"already_blacklisted\": false, \"blacklist_file\": \"${exim_bl_s}\"}"
            printf '%s\n' "$param" | $SUDO tee -a "$exim_bl_s" >/dev/null 2>&1 \
                || { output_action_json "false" "$cmd" \
                    "Falha ao escrever em $exim_bl_s"; exit 1; }
            output_action_json "true" "$cmd" \
                "Remetente $param adicionado à blacklist ($exim_bl_s)" "$_before"
            ;;

        retry-queue)
            "$EXIM_BIN" -qff 2>/dev/null
            output_action_json "true" "$cmd" \
                "Reprocessamento forçado da fila ($EXIM_BIN -qff) concluído"
            ;;

        check-deliverability)
            # Domínio opcional via param (--action=check-deliverability:dominio.com);
            # sem param, cai no fallback de _detect_domain (remetente
            # ativo/relay/auth top, depois domínio do host).
            local _domain="$param"
            if [ -n "$_domain" ] && ! _validate_action_param "$_domain"; then
                output_action_json "false" "$cmd" \
                    "Parâmetro inválido: '$_domain' contém caracteres não permitidos"
                exit 1
            fi
            local _bl_json _deliv_json _cert_json
            _bl_json=$(check_blacklists_json)
            _deliv_json=$(check_deliverability_json "$_domain")
            _cert_json=$(check_cert_json "$_domain")
            output_action_json "true" "$cmd" \
                "Checagem de deliverability concluída" \
                "${_bl_json}, ${_deliv_json}, ${_cert_json}"
            ;;

        *)
            output_action_json "false" "$cmd" \
                "Ação desconhecida: '$cmd'. Opções: clean-full, clean-frozen, clean-bounces, clean-sender:<addr>, clean-auth:<user>, block-ip:<ip>, block-sender:<email>, retry-queue, check-deliverability[:dominio], check-ip-status --ip=<ip>, unblock-ip --ip=<ip> --tool=csf|imunify360"
            exit 1
            ;;
    esac
}

# ============================================================
# PRINTS
# ============================================================
print_header() {
    clear 2>/dev/null || true
    echo
    echo -e "${LCYAN}╔══════════════════════════════════════════════════════════════════════╗${RESET}"
    echo -e "${LCYAN}║${RESET}  ${BOLD}${WHITE}EXIM MONITOR PRO v${VERSION}${RESET}   ${DIM}${DATE}${RESET}"
    echo -e "${LCYAN}║${RESET}  ${DIM}Host: ${HOSTNAME}${RESET}"
    echo -e "${LCYAN}╚══════════════════════════════════════════════════════════════════════╝${RESET}"
}

print_status() {
    section "STATUS GERAL"
    case "$SEVERITY" in
        CRITICAL) badge_crit "$PROBLEM — $PROBLEM_DESC" ;;
        HIGH)     badge_warn "$PROBLEM — $PROBLEM_DESC" ;;
        MEDIUM)   badge_warn "$PROBLEM — $PROBLEM_DESC" ;;
        LOW)      badge_warn "$PROBLEM — $PROBLEM_DESC" ;;
        OK)       badge_ok   "$PROBLEM — $PROBLEM_DESC" ;;
    esac
    echo
    printf "  %-22s "; bar "$QUEUE"          10000; echo "  Fila total"
    printf "  %-22s "; bar "$FROZEN_COUNT"   500;   echo "  Frozen"
    printf "  %-22s "; bar "$BOUNCE_COUNT"   1000;  echo "  Bounces na fila"
    printf "  %-22s "; bar "$DELIVERED_COUNT" 5000; echo "  Entregas (log)"
    printf "  %-22s "; bar "$REJECT_COUNT"   1000;  echo "  Rejeições (log)"
    printf "  %-22s "; bar "$DEFER_COUNT"    2000;  echo "  Deferimentos (log)"
    echo
    echo -e "  ${DIM}Fila: ${BOLD}${QUEUE_SIZE} KB${RESET}  |  Processos: ${BOLD}${EXIM_PROCS}${RESET}  |  Uptime daemon: ${BOLD}${EXIM_UPTIME}${RESET}"
    [ "$TOP_OWN_IP_COUNT" -gt 0 ] && \
        echo -e "  ${DIM}ℹ  IP do próprio servidor (${TOP_OWN_IP_ADDR}) aparece no log com ${TOP_OWN_IP_COUNT} entradas — excluído da análise.${RESET}"
}

print_age() {
    section "IDADE DAS MENSAGENS NA FILA"
    printf "  %-25s ${RED}%s${RESET}\n"    "Antigas (> 1 dia):" "$OLD_DAYS"
    printf "  %-25s ${YELLOW}%s${RESET}\n" "Horas atrás:"       "$OLD_HOURS"
    printf "  %-25s ${GREEN}%s${RESET}\n"  "Minutos atrás:"     "$OLD_MINS"
    echo
    subsec "Mensagem mais antiga: ${YELLOW}${OLDEST_IN_QUEUE:-N/A}${RESET}"
}

print_senders() {
    section "TOP REMETENTES (na fila)"
    if [ -z "$TOP_SENDERS" ]; then
        echo -e "  ${YELLOW}Nenhum remetente com endereço na fila — apenas bounces <> presentes.${RESET}"
        echo -e "  ${DIM}Isso indica que todas as mensagens com remetente real já saíram${RESET}"
        echo -e "  ${DIM}e os bounces de retorno estão acumulando.${RESET}"
    else
        echo -e "  ${DIM}Count  Endereço${RESET}"; hr_thin
        local i=0
        while IFS= read -r line; do
            i=$((i+1)); cnt=$(echo "$line"|awk '{print $1}'); addr=$(echo "$line"|awk '{print $2}')
            [ "$i" -eq 1 ] && color="$LRED" || color="$WHITE"
            printf "  ${color}%-6s${RESET} %s\n" "$cnt" "$addr"
        done <<< "$TOP_SENDERS"
    fi
    echo
    subsec "Top domínios remetentes:"
    if [ -n "$TOP_SENDER_DOMAINS" ]; then
        echo -e "  ${DIM}Count  Domínio${RESET}"; hr_thin
        echo "$TOP_SENDER_DOMAINS" | while read -r line; do
            printf "  %-6s %s\n" "$(echo "$line"|awk '{print $1}')" "$(echo "$line"|awk '{print $2}')"
        done
    else
        echo -e "  ${DIM}Nenhum.${RESET}"
    fi
    if [ -n "$RELAY_SUSPECT" ]; then
        echo
        subsec "${LRED}⚠ Padrão de relay detectado:${RESET}"
        echo -e "  Suspeito: ${BOLD}${LRED}${RELAY_SUSPECT}${RESET}"
        echo -e "  Como remetente (From): ${BOLD}${RELAY_SUSPECT_SEND}${RESET} msgs"
        echo -e "  Como destino de bounces (<>): ${BOLD}${RELAY_SUSPECT_BOUNCE}${RESET} msgs"
    fi
}

print_recipients() {
    section "TOP DESTINATÁRIOS (na fila)"
    if [ -z "$TOP_RECIPIENTS" ]; then
        echo -e "  ${DIM}Nenhum destinatário identificado.${RESET}"
    else
        echo -e "  ${DIM}Count  Endereço${RESET}"; hr_thin
        local i=0
        while IFS= read -r line; do
            i=$((i+1)); cnt=$(echo "$line"|awk '{print $1}'); addr=$(echo "$line"|awk '{print $2}')
            [ "$i" -eq 1 ] && color="$YELLOW" || color="$WHITE"
            printf "  ${color}%-6s${RESET} %s\n" "$cnt" "$addr"
        done <<< "$TOP_RECIPIENTS"
    fi
    echo
    subsec "Top domínios de destino:"
    echo -e "  ${DIM}Count  Domínio${RESET}"; hr_thin
    echo "$TOP_DEST_DOMAINS" | while read -r line; do
        printf "  %-6s %s\n" "$(echo "$line"|awk '{print $1}')" "$(echo "$line"|awk '{print $2}')"
    done
}

print_auth() {
    section "SMTP AUTH — USUÁRIOS AUTENTICADOS (log)"
    if [ -z "$AUTH_USERS" ]; then
        echo -e "  ${YELLOW}Nenhum envio autenticado encontrado.${RESET}"
        echo -e "  ${DIM}Possíveis causas:${RESET}"
        echo -e "  ${DIM}  • Injeção via PHP mail() / script web (sem SMTP AUTH)${RESET}"
        echo -e "  ${DIM}  • Relay aberto ou ACL permissiva no Exim${RESET}"
        echo -e "  ${DIM}  • Envio por processo local (www-data, nobody, etc.)${RESET}"
    else
        echo -e "  ${DIM}Count  Usuário / Método${RESET}"; hr_thin
        local i=0
        while IFS= read -r line; do
            i=$((i+1)); cnt=$(echo "$line"|awk '{print $1}'); usr=$(echo "$line"|awk '{print $2}')
            [ "$i" -eq 1 ] && color="$LRED" || color="$WHITE"
            printf "  ${color}%-6s${RESET} %s\n" "$cnt" "$usr"
        done <<< "$AUTH_USERS"
    fi
}

print_ips() {
    section "TOP IPs REMETENTES EXTERNOS (log)"
    if [ -z "$TOP_IPS" ]; then
        echo -e "  ${DIM}Nenhum IP externo identificado.${RESET}"
    else
        echo -e "  ${DIM}Count  IP${RESET}"; hr_thin
        local i=0
        while IFS= read -r line; do
            [ -z "$line" ] && continue
            i=$((i+1)); cnt=$(echo "$line"|awk '{print $1}'); ip=$(echo "$line"|awk '{print $2}')
            [ "$i" -eq 1 ] && color="$MAGENTA" || color="$WHITE"
            printf "  ${color}%-6s${RESET} %s\n" "$cnt" "$ip"
        done <<< "$TOP_IPS"
    fi
    [ "$TOP_OWN_IP_COUNT" -gt 0 ] && \
        echo -e "\n  ${DIM}ℹ  IP próprio ${TOP_OWN_IP_ADDR} excluído (${TOP_OWN_IP_COUNT} entradas — normal).${RESET}"
}

print_hourly_stats() {
    local hours="${HOURS_WINDOW:-6}"
    section "TRÁFEGO POR HORA (últimas ${hours}h)"

    # Escala máxima para as barras
    local max=1 i
    for i in "${!HOURLY_RECV[@]}"; do
        [ "${HOURLY_RECV[$i]}" -gt "$max" ] && max=${HOURLY_RECV[$i]}
        [ "${HOURLY_SENT[$i]}" -gt "$max" ] && max=${HOURLY_SENT[$i]}
    done

    printf "  ${DIM}%-7s  %-26s  %-26s${RESET}\n" "Hora" "Recebidas (<=)" "Entregues (=>)"
    hr_thin

    for i in "${!HOURLY_HOURS[@]}"; do
        local r=${HOURLY_RECV[$i]}
        local s=${HOURLY_SENT[$i]}
        printf "  ${BOLD}%s${RESET}  " "${HOURLY_HOURS[$i]}"
        bar_c "$GREEN" "$r" "$max" 15
        printf "  "
        bar_c "$CYAN"  "$s" "$max" 15
        echo
    done

    hr_thin
    printf "  ${BOLD}%-7s${RESET}  " "Total"
    printf "${GREEN}${BOLD}%-6s${RESET} recebidas   " "$TOTAL_RECV_WINDOW"
    printf "${CYAN}${BOLD}%-6s${RESET} entregues\n"  "$TOTAL_SENT_WINDOW"

    if [ "$TOTAL_RECV_WINDOW" -eq 0 ] && [ "$TOTAL_SENT_WINDOW" -eq 0 ]; then
        echo -e "\n  ${DIM}ℹ  Sem tráfego no log das últimas ${hours}h."
        echo -e "     O LOG_SAMPLE (${LOG_LINES} linhas) pode não cobrir este período.${RESET}"
    fi
    echo -e "\n  ${DIM}Use --hours=N para ampliar a janela de análise.${RESET}"
}

print_errors() {
    section "ERROS E REJEIÇÕES (log)"
    printf "  %-30s ${RED}%s${RESET}\n"    "Rejeições (5xx):"        "$REJECT_COUNT"
    printf "  %-30s ${YELLOW}%s${RESET}\n" "Deferimentos:"           "$DEFER_COUNT"
    printf "  %-30s ${YELLOW}%s${RESET}\n" "Bounces no log:"         "$BOUNCE_LOG_COUNT"
    printf "  %-30s ${CYAN}%s${RESET}\n"   "Erros DNS:"              "$DNS_ERRORS"
    printf "  %-30s ${GREEN}%s${RESET}\n"  "Envios recentes no log:" "$RECENT_SENDS"
    if [ -n "$TOP_REJECTED_DOMAINS" ]; then
        echo; subsec "Domínios com mais rejeições:"
        echo "$TOP_REJECTED_DOMAINS" | while read -r line; do
            printf "  %-6s %s\n" "$(echo "$line"|awk '{print $1}')" "$(echo "$line"|awk '{print $2}')"
        done
    fi
    if [ -n "$TOP_DEFER_DOMAINS" ]; then
        echo; subsec "Domínios com mais deferimentos:"
        echo "$TOP_DEFER_DOMAINS" | while read -r line; do
            printf "  %-6s %s\n" "$(echo "$line"|awk '{print $1}')" "$(echo "$line"|awk '{print $2}')"
        done
    fi
}

print_diagnosis() {
    section "DIAGNÓSTICO"
    case "$PROBLEM" in
        SPAM_RELAY)
            echo -e "  ${LRED}▶ SPAM RELAY / BACKSCATTER DETECTADO${RESET}"
            echo
            echo -e "  ${BOLD}O que está acontecendo:${RESET}"
            echo -e "  O endereço ${BOLD}${LRED}${RELAY_SUSPECT}${RESET} foi utilizado como remetente para"
            echo -e "  disparar e-mails em massa através deste servidor. Os servidores de"
            echo -e "  destino rejeitaram parte das mensagens e enviaram bounces (NDR) de"
            echo -e "  volta, que estão acumulando na fila com remetente ${BOLD}<>${RESET}."
            echo
            printf "  %-38s ${LRED}%s${RESET}\n"   "Remetente do spam:"             "$RELAY_SUSPECT"
            printf "  %-38s ${YELLOW}%s${RESET}\n"  "Msgs enviadas (From):"          "$RELAY_SUSPECT_SEND"
            printf "  %-38s ${YELLOW}%s${RESET}\n"  "Bounces acumulados (<>):"       "$RELAY_SUSPECT_BOUNCE"
            printf "  %-38s ${CYAN}%s${RESET}\n"    "Destinatário concentrado:"      "$TOP_RECIPIENT"
            printf "  %-38s ${CYAN}%s${RESET}\n"    "Msgs para esse dest.:"         "$TOP_RECIPIENT_COUNT"
            if [ -n "$RELAY_TARGET_DOMAINS" ]; then
                echo
                subsec "Domínios-alvo do spam disparado:"
                echo "$RELAY_TARGET_DOMAINS" | while read -r line; do
                    printf "    %-6s %s\n" "$(echo "$line"|awk '{print $1}')" "$(echo "$line"|awk '{print $2}')"
                done
            fi
            if [ -n "$TOP_DEFER_DOMAINS" ]; then
                echo
                subsec "Domínios que bloquearam/deferenciaram:"
                echo "$TOP_DEFER_DOMAINS" | head -5 | while read -r line; do
                    printf "    %-6s %s\n" "$(echo "$line"|awk '{print $1}')" "$(echo "$line"|awk '{print $2}')"
                done
            fi
            echo
            echo -e "  ${BOLD}Como o relay aconteceu? (investigar):${RESET}"
            echo -e "  ${DIM}  • Sem SMTP AUTH no log → provavelmente via PHP mail() ou script web${RESET}"
            echo -e "  ${DIM}  • Verifique: grep -r 'mail(' /var/www --include='*.php' | head -20${RESET}"
            echo -e "  ${DIM}  • Verifique relay aberto: exim -bh <IP_SUSPEITO>${RESET}"
            echo -e "  ${DIM}  • Verifique ACL: grep acl_check_rcpt /etc/exim4/exim4.conf*${RESET}"
            echo
            echo -e "  ${BOLD}Ações recomendadas:${RESET}"
            echo -e "  ${LRED}  [1]${RESET} Limpar toda a fila (bounces + pendentes)"
            echo -e "  ${LRED}  [2]${RESET} Limpar apenas bounces (<>)"
            [ -n "$TOP_IP" ] && echo -e "  ${YELLOW}  [3]${RESET} Bloquear IP de origem: ${BOLD}$TOP_IP${RESET}"
            echo -e "  ${CYAN}  [b]${RESET} Verificar blacklists agora"
            echo -e "  ${CYAN}  [p]${RESET} Procurar scripts PHP com mail()"
            ;;

        BOUNCE_CONCENTRADO)
            echo -e "  ${LRED}▶ BOUNCE STORM CONCENTRADO${RESET}"
            echo
            echo -e "  ${BOLD}O que está acontecendo:${RESET}"
            echo -e "  Acúmulo de bounces (remetente <>) cujo destino é ${BOLD}${TOP_RECIPIENT}${RESET}."
            echo -e "  Esse endereço pode ter sido forjado como remetente em spam externo,"
            echo -e "  e os bounces estão chegando de volta (backscatter)."
            echo
            printf "  %-35s ${LRED}%s${RESET}\n"   "Bounces na fila:"           "$BOUNCE_COUNT"
            printf "  %-35s ${YELLOW}%s${RESET}\n"  "Destino concentrado:"       "$TOP_RECIPIENT"
            printf "  %-35s ${YELLOW}%s${RESET}\n"  "Msgs para esse destino:"    "$TOP_RECIPIENT_COUNT"
            echo
            echo -e "  ${BOLD}Ações recomendadas:${RESET}"
            echo -e "  ${LRED}  [1]${RESET} Limpar bounces (<>) da fila"
            echo -e "  ${YELLOW}  [2]${RESET} Limpar toda a fila"
            echo -e "  ${CYAN}  [b]${RESET} Verificar blacklists"
            ;;

        ENVIO_THROTTLED)
            echo -e "  ${YELLOW}▶ ENVIO EM MASSA AUTENTICADO — LIMITADO POR PROVEDORES${RESET}"
            echo -e "  Remetente: ${BOLD}$TOP_SENDER${RESET} (${YELLOW}$TOP_SENDER_COUNT mensagens na fila${RESET})"
            echo -e "  Conta autenticada: ${BOLD}$TOP_AUTH_USER${RESET}"
            echo
            echo -e "  ${DIM}Este é um envio legítimo autenticado via SMTP, mas os provedores${RESET}"
            echo -e "  ${DIM}de destino (Gmail, Hotmail etc.) estão aplicando rate limiting —${RESET}"
            echo -e "  ${DIM}limitando quantos e-mails aceitam por hora/dia deste IP.${RESET}"
            echo
            echo -e "  ${DIM}Ações recomendadas:${RESET}"
            echo -e "  ${DIM}  1. Aguardar: o EXIM vai retentar automaticamente.${RESET}"
            echo -e "  ${DIM}  2. Verificar reputação do IP: https://postmaster.google.com${RESET}"
            echo -e "  ${DIM}  3. Checar se SPF/DKIM/DMARC estão configurados corretamente.${RESET}"
            echo -e "  ${DIM}  4. Considerar reduzir volume ou usar serviço de relay transacional.${RESET}"
            ;;

        SPAM_MASSIVO)
            echo -e "  ${LRED}▶ SPAM MASSIVO DETECTADO${RESET}"
            echo -e "  Remetente: ${BOLD}$TOP_SENDER${RESET} (${LRED}$TOP_SENDER_COUNT mensagens${RESET})"
            echo -e "  ${DIM}Ação: bloquear remetente, limpar fila, checar scripts comprometidos.${RESET}"
            ;;

        AUTH_ABUSE)
            echo -e "  ${LRED}▶ CONTA SMTP COMPROMETIDA${RESET}"
            echo -e "  Usuário: ${BOLD}$TOP_AUTH_USER${RESET} (${LRED}$TOP_AUTH_COUNT envios${RESET})"
            echo -e "  ${DIM}Ação: trocar senha imediatamente, limpar fila do usuário.${RESET}"
            ;;

        IP_FLOOD)
            echo -e "  ${YELLOW}▶ FLOOD POR IP EXTERNO${RESET}"
            echo -e "  IP: ${BOLD}$TOP_IP${RESET} (${YELLOW}$TOP_IP_COUNT conexões${RESET})"
            echo -e "  ${DIM}Ação: bloquear IP no firewall, verificar ACL do Exim.${RESET}"
            ;;

        FILA_TRAVADA)
            echo -e "  ${YELLOW}▶ FILA TRAVADA${RESET}"
            echo -e "  Msgs >1 dia: ${BOLD}$OLD_DAYS${RESET} | Frozen: ${BOLD}$FROZEN_COUNT${RESET}"
            echo -e "  ${DIM}Ação: remover frozen, verificar MX externos, checar DNS.${RESET}"
            ;;

        ALTO_DEFERIMENTO)
            echo -e "  ${YELLOW}▶ ALTO DEFERIMENTO — DESTINOS BLOQUEANDO ENTREGAS${RESET}"
            echo
            printf "  %-35s ${YELLOW}%s${RESET}\n" "Total de deferimentos:" "$DEFER_COUNT"
            if [ -n "$TOP_DEFER_DOMAINS" ]; then
                echo; subsec "Domínios que estão deferindo:"
                echo "$TOP_DEFER_DOMAINS" | while read -r line; do
                    printf "    %-6s %s\n" "$(echo "$line"|awk '{print $1}')" "$(echo "$line"|awk '{print $2}')"
                done
            fi
            echo
            echo -e "  ${DIM}Ação: verificar blacklists, reputação do IP, SPF/DKIM/DMARC.${RESET}"
            ;;

        BOUNCE_STORM)
            echo -e "  ${YELLOW}▶ BOUNCE STORM${RESET}"
            echo -e "  Bounces na fila: ${BOLD}$BOUNCE_COUNT${RESET}"
            echo -e "  ${DIM}Ação: verificar listas de e-mail, reputação do IP.${RESET}"
            ;;

        ALTA_REJEICAO)
            echo -e "  ${CYAN}▶ ALTA TAXA DE REJEIÇÃO${RESET}"
            echo -e "  Rejeições: ${BOLD}$REJECT_COUNT${RESET}"
            echo -e "  ${DIM}Ação: checar blacklists, DKIM/SPF/DMARC.${RESET}"
            ;;

        FILA_ALTA)
            echo -e "  ${CYAN}▶ FILA ELEVADA SEM CAUSA ÓBVIA${RESET}"
            echo -e "  ${DIM}Ação: investigar remetentes, destinos e erros.${RESET}"
            ;;

        NORMAL)
            echo -e "  ${LGREEN}▶ FILA OPERANDO NORMALMENTE${RESET}"
            echo -e "  ${DIM}Nenhuma ação necessária.${RESET}"
            ;;
    esac
}


# ============================================================
# SEÇÃO VISUAL — DETALHE DE DEFERIMENTOS
# Exibida automaticamente quando DEFER_COUNT > 200
# ============================================================

# Traduz códigos internos do EXIM e mensagens de erro comuns para texto legível.
# Entrada: linha no formato "  N  <código ou mensagem>"
# Saída:   linha com explicação anexada
_explain_defer_error() {
    local msg="$1"
    # Códigos internos EXIM (errno do kernel capturado como "defer (N)")
    case "$msg" in
        -44) echo "Conexão recusada pelo servidor remoto (Connection refused)" ;;
        -45) echo "Host inacessível — rota de rede não encontrada (No route to host)" ;;
        -47) echo "Timeout de conexão — servidor remoto não respondeu a tempo" ;;
        -48) echo "Rede inacessível (Network unreachable)" ;;
        -52) echo "Timeout durante transferência de dados (connection timed out)" ;;
        -53) echo "DNS: domínio não encontrado (NXDOMAIN / lookup failure)" ;;
        -54) echo "Conexão encerrada pelo servidor remoto (Connection reset by peer)" ;;
        -61) echo "Recusa de conexão — porta 25 bloqueada ou serviço parado (Connection refused)" ;;
        *)
            # Mensagens SMTP 4xx conhecidas
            case "$msg" in
                *"daily rate"*|*"rate limit"*|*"too many"*|*"frequency"*)
                    echo "$msg → Rate limiting: o provedor limita o volume de mensagens por dia/hora deste IP" ;;
                *"Greylisted"*|*"greylisting"*)
                    echo "$msg → Greylisting: servidor temporariamente recusando novos remetentes (normal, reenvio automático resolve)" ;;
                *"IP reputation"*|*"blocked"*|*"blacklist"*|*"blacklisted"*)
                    echo "$msg → IP com má reputação ou em blacklist — verifique: https://mxtoolbox.com/blacklists.aspx" ;;
                *"SPF"*|*"DKIM"*|*"DMARC"*)
                    echo "$msg → Falha de autenticação de e-mail — verifique registros SPF/DKIM/DMARC no DNS" ;;
                *"452"*|*"insufficient"*|*"quota"*|*"full"*)
                    echo "$msg → Caixa do destinatário cheia ou cota do servidor esgotada" ;;
                *"421"*)
                    echo "$msg → Servidor remoto temporariamente indisponível (421) — EXIM vai retentar" ;;
                *"450"*|*"451"*)
                    echo "$msg → Recusa temporária (4xx) — EXIM vai retentar automaticamente" ;;
                *)
                    echo "$msg" ;;
            esac ;;
    esac
}

print_defers() {
    [ "$DEFER_DETAIL_AVAILABLE" -eq 0 ] && return

    section "DETALHE DOS DEFERIMENTOS"

    # ── Cabeçalho resumido ────────────────────────────────────────────
    printf "  %-30s ${YELLOW}%s${RESET}\n"   "Total de deferimentos:"   "$DEFER_COUNT"
    printf "  %-30s ${CYAN}%s${RESET}\n"     "Domínio principal:"       "$TOP_DEFER_DOMAIN"
    if [ "$DEFER_SPAN_MIN" -gt 0 ]; then
        printf "  %-30s ${DIM}%s${RESET}\n"  "Período no log:"          "${DEFER_SPAN_MIN} min  ($DEFER_FIRST_TIME → $DEFER_LAST_TIME)"
        printf "  %-30s ${YELLOW}%s${RESET}\n" "Taxa aproximada:"        "~${DEFER_RATE} defers/min"
    fi

    # ── Interpretação automática ──────────────────────────────────────
    if [ -n "$DEFER_INTERPRETATION" ]; then
        echo
        echo -e "  ${BOLD}Interpretação:${RESET}"
        echo -e "  ${YELLOW}⚠  $DEFER_INTERPRETATION${RESET}"
    fi

    # ── Mensagens de erro reais ───────────────────────────────────────
    echo
    subsec "Erros retornados pelo servidor remoto:"
    if [ -n "$DEFER_ERRORS" ]; then
        echo -e "  ${DIM}Count  Mensagem / Explicação${RESET}"
        hr_thin
        local i=0
        while IFS= read -r line; do
            [ -z "$line" ] && continue
            i=$((i+1))
            cnt=$(echo "$line" | awk '{print $1}')
            msg=$(echo "$line" | awk '{$1=""; print}' | sed 's/^ //')
            [ "$i" -eq 1 ] && color="$LRED" || color="$WHITE"
            explained=$(_explain_defer_error "$msg")
            if [ "$explained" = "$msg" ]; then
                printf "  ${color}%-6s${RESET} %s\n" "$cnt" "$msg"
            else
                printf "  ${color}%-6s${RESET} %s\n" "$cnt" "$explained"
            fi
        done <<< "$DEFER_ERRORS"
    else
        echo -e "  ${DIM}Não foi possível extrair mensagens de erro do log.${RESET}"
        echo -e "  ${DIM}Use [e] no menu para ver as linhas brutas do log.${RESET}"
    fi

    # ── Destinatários mais deferidos ──────────────────────────────────
    if [ -n "$DEFER_RECIPIENTS" ]; then
        echo
        subsec "Destinatários com mais defers:"
        echo -e "  ${DIM}Count  Endereço${RESET}"
        hr_thin
        local j=0
        while IFS= read -r line; do
            [ -z "$line" ] && continue
            j=$((j+1))
            cnt=$(echo  "$line" | awk '{print $1}')
            addr=$(echo "$line" | awk '{print $2}')
            [ "$j" -eq 1 ] && color="$YELLOW" || color="$WHITE"
            printf "  ${color}%-6s${RESET} %s\n" "$cnt" "$addr"
        done <<< "$DEFER_RECIPIENTS"
    fi
}

# ============================================================
# FUNÇÕES DE AÇÃO
# ============================================================

# Flag global: marcado como 1 sempre que qualquer limpeza for executada.
# Usado para oferecer remoção do script ao recarregar após uma limpeza.
QUEUE_CLEANED=0

# Pergunta se o operador deseja excluir o próprio script.
# $1 = contexto exibido na pergunta (ex: "antes de sair" / "após limpeza")
maybe_delete_script() {
    local ctx="${1:-}"
    local script_path
    script_path="$(realpath "$0" 2>/dev/null || readlink -f "$0" 2>/dev/null || echo "$0")"
    echo
    echo -e "  ${DIM}Script: ${script_path}${RESET}"
    read -rp "  Deseja excluir o script${ctx:+ $ctx}? [s/N]: " del
    if [[ "$del" =~ ^[sS]$ ]]; then
        rm -f "$script_path"
        echo -e "  ${GREEN}[OK] Script removido.${RESET}"
        sleep 1
        exit 0
    else
        echo -e "  ${DIM}Script mantido.${RESET}"
    fi
}

clean_full() {
    echo -e "${YELLOW}[AÇÃO] Limpando toda a fila...${RESET}"
    exim -bp 2>/dev/null | awk '{print $3}' | grep -E '^[A-Za-z0-9-]{6,}$' | xargs -r -P4 exim -Mrm >/dev/null 2>&1
    echo -e "${GREEN}[OK] Fila limpa.${RESET}"
    QUEUE_CLEANED=1
}
clean_frozen() {
    echo -e "${YELLOW}[AÇÃO] Removendo frozen...${RESET}"
    exiqgrep -z -i 2>/dev/null | grep -E '^[A-Za-z0-9-]{6,}$' | xargs -r -P4 exim -Mrm >/dev/null 2>&1
    echo -e "${GREEN}[OK] Frozen removidos.${RESET}"
    QUEUE_CLEANED=1
}
clean_bounces() {
    echo -e "${YELLOW}[AÇÃO] Removendo bounces (<>)...${RESET}"
    exiqgrep -f '<>' -i 2>/dev/null | grep -E '^[A-Za-z0-9-]{6,}$' | xargs -r -P4 exim -Mrm >/dev/null 2>&1
    echo -e "${GREEN}[OK] Bounces removidos.${RESET}"
    QUEUE_CLEANED=1
}
clean_by_sender() {
    echo -e "${YELLOW}[AÇÃO] Removendo fila de $1...${RESET}"
    exiqgrep -f "$1" -i 2>/dev/null | grep -E '^[A-Za-z0-9-]{6,}$' | xargs -r -P4 exim -Mrm >/dev/null 2>&1
    echo -e "${GREEN}[OK]${RESET}"
    QUEUE_CLEANED=1
}
clean_by_auth_user() {
    echo -e "${YELLOW}[AÇÃO] Removendo fila do usuário $1...${RESET}"
    for mid in $(exiqgrep -f "" -i 2>/dev/null | head -200); do
        exim -Mvh "$mid" 2>/dev/null | grep -q "auth_id.*$1" && exim -Mrm "$mid" >/dev/null 2>&1
    done
    echo -e "${GREEN}[OK]${RESET}"
    QUEUE_CLEANED=1
}
block_ip_iptables() {
    if command -v iptables &>/dev/null; then
        iptables -I INPUT -s "$1" -p tcp --dport 25 -j DROP
        echo -e "${GREEN}[OK] $1 bloqueado na porta 25 (apenas sessão atual).${RESET}"
    else
        echo -e "${RED}[ERRO] iptables não disponível.${RESET}"
    fi
}

# ============================================================
# BLOQUEIO DE IP — PERSISTÊNCIA COMPARTILHADA
# Escreve a regra em /etc/firewall.d/03_custom, checa duplicata e
# reinicia firewall.service — usada tanto pela ação via API
# (execute_action → block-ip, sem prompt, bloqueia via iptables
# imediatamente ANTES de chamar esta função) quanto pelo menu
# interativo (block_ip_firewall_d, pede ticket, confia só no restart
# do serviço pra aplicar). Uma correção futura aqui (ex.: adaptação
# pra CSF) vale pros dois chamadores de uma vez.
#
# $1 = ip, $2 = linha de comentário pra regra (ticket ou timestamp).
# Imprime uma mensagem de status em stdout. Retorno: 0 = regra
# adicionada (com ou sem restart bem-sucedido), 1 = duplicata
# (nenhuma alteração), 2 = falha ao preparar o diretório/arquivo.
# ============================================================
_block_ip_persist() {
    local ip="$1" comment_line="$2"
    local fw_file="/etc/firewall.d/03_custom"
    local fw_dir="/etc/firewall.d"

    if [ ! -d "$fw_dir" ] && ! $SUDO mkdir -p "$fw_dir" 2>/dev/null; then
        printf 'firewall.d: %s não encontrado e não foi possível criar' "$fw_dir"
        return 2
    fi

    if [ -f "$fw_file" ] && grep -qF "$ip" "$fw_file" 2>/dev/null; then
        printf 'firewall.d: %s já está presente em %s' "$ip" "$fw_file"
        return 1
    fi

    if [ ! -f "$fw_file" ]; then
        printf '#!/bin/sh\n# Regras customizadas — gerado por diag-exim.sh\n' \
            | $SUDO tee "$fw_file" >/dev/null 2>&1
        $SUDO chmod 640 "$fw_file" 2>/dev/null
    fi

    printf '\n%s\n$IPTABLES -I INPUT -s %s -j DROP\n' "$comment_line" "$ip" \
        | $SUDO tee -a "$fw_file" >/dev/null 2>&1

    if $SUDO systemctl restart firewall.service 2>/dev/null; then
        printf 'firewall.d: regra adicionada em %s e firewall.service reiniciado' "$fw_file"
    else
        printf 'firewall.d: regra adicionada em %s (falha ao reiniciar firewall.service)' "$fw_file"
    fi
    return 0
}

# Menu interativo — pede número do ticket antes de gravar (diferença de
# UX proposital vs a ação via API, que não tem operador humano do outro
# lado). Mantém a checagem de duplicata "prévia" aqui (com preview das
# linhas já existentes) só pra decidir se vale incomodar o operador com
# o prompt de ticket — a checagem "de verdade" é a de dentro de
# _block_ip_persist, que roda de qualquer forma.
block_ip_firewall_d() {
    local ip="$1"
    local fw_file="/etc/firewall.d/03_custom"

    if [ -f "$fw_file" ] && grep -qF "$ip" "$fw_file" 2>/dev/null; then
        echo -e "  ${YELLOW}⚠ ${ip} já está presente em ${fw_file}:${RESET}"
        grep -n "$ip" "$fw_file" | while read -r line; do
            echo -e "  ${DIM}  ${line}${RESET}"
        done
        echo -e "  ${DIM}Nenhuma alteração realizada.${RESET}"
        return 0
    fi

    echo
    echo -e "  ${BOLD}${WHITE}Qual o número do ticket para esta regra de bloqueio?${RESET}"
    read -rp "  Ticket: " ticket_num
    [ -z "$ticket_num" ] && ticket_num="s/n"

    local _msg _status
    _msg=$(_block_ip_persist "$ip" "#Ticket $ticket_num"); _status=$?
    if [ "$_status" -eq 0 ]; then
        echo -e "  ${GREEN}✔ ${_msg}${RESET}"
    else
        echo -e "  ${RED}✖ ${_msg}${RESET}"
        echo -e "  ${DIM}Este servidor pode não usar firewall.d — verifique a configuração.${RESET}"
    fi
}
retry_queue() {
    echo -e "${YELLOW}[AÇÃO] Forçando reprocessamento...${RESET}"
    exim -qff 2>/dev/null
    echo -e "${GREEN}[OK]${RESET}"
}
# ============================================================
# DETECÇÃO DE IP PÚBLICO
# hostname -I sozinho pode devolver o IP de uma interface interna
# (rede docker, VPN, etc.) em vez do IP público real — nesse caso a
# checagem de blocklist testaria o endereço errado, silenciosamente.
# Tenta dois serviços externos independentes antes de aceitar
# hostname -I como último recurso, e sempre valida que o resultado
# não é um IP privado/loopback. Retorna 1 (sem imprimir nada) se
# nenhum método confiável funcionar — chamador deve tratar esse caso
# explicitamente em vez de seguir com um valor possivelmente errado.
# ============================================================
_is_private_ip() {
    local ip="$1"
    case "$ip" in
        10.*|127.*|192.168.*) return 0 ;;
        172.1[6-9].*|172.2[0-9].*|172.3[01].*) return 0 ;;
    esac
    return 1
}

_detect_public_ip() {
    local ip svc
    for svc in "curl -s4 --max-time 5 ifconfig.me" "curl -s4 --max-time 5 api.ipify.org"; do
        ip=$($svc 2>/dev/null | tr -d '[:space:]')
        if printf '%s' "$ip" | grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$' && ! _is_private_ip "$ip"; then
            printf '%s' "$ip"; return 0
        fi
    done
    # Último recurso: IP local — só aceito se não for privado (raro, mas
    # possível em servidor com IP público direto na interface)
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    if printf '%s' "$ip" | grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$' && ! _is_private_ip "$ip"; then
        printf '%s' "$ip"; return 0
    fi
    return 1
}

# ============================================================
# DETECÇÃO DE DOMÍNIO PARA CHECAGENS DE DELIVERABILITY
# Extrai do remetente mais ativo / suspeito de relay / usuário
# autenticado top; cai pro domínio do próprio host como último
# recurso. Compartilhado entre a versão interativa e a --json-aware
# (check_dkim_spf, check_deliverability_json) — não duplicar.
# ============================================================
_detect_domain() {
    local domain="" _src
    for _src in "$TOP_SENDER" "$RELAY_SUSPECT" "$TOP_AUTH_USER"; do
        [ -z "$_src" ] && continue
        domain=$(echo "$_src" | grep -oP '@\K[^@\s]+' | head -1)
        [ -n "$domain" ] && break
    done
    [ -z "$domain" ] && domain=$(hostname -d 2>/dev/null || hostname -f | cut -d. -f2-)
    printf '%s' "$domain"
}

check_blacklists() {
    local ip
    if ! ip=$(_detect_public_ip); then
        echo -e "  ${RED}✖ Não foi possível determinar o IP público do servidor — checagem de blocklist pulada.${RESET}"
        return 1
    fi
    echo -e "${CYAN}IP do servidor: ${BOLD}$ip${RESET}"
    for bl in zen.spamhaus.org bl.spamcop.net dnsbl.sorbs.net b.barracudacentral.org; do
        rev_ip=$(echo "$ip" | awk -F. '{print $4"."$3"."$2"."$1}')
        result=$(host -t A "${rev_ip}.${bl}" 2>/dev/null | grep -c "127\.")
        [ "$result" -gt 0 ] && echo -e "  ${RED}✖ LISTADO em $bl${RESET}" || echo -e "  ${GREEN}✔ Limpo em $bl${RESET}"
    done
}
check_dkim_spf() {
    local domain; domain=$(_detect_domain)
    echo -e "${CYAN}Verificando SPF/DKIM para: ${BOLD}$domain${RESET}"
    command -v host &>/dev/null || { echo -e "  ${DIM}'host' não disponível.${RESET}"; return; }
    SPF=$(host -t TXT "$domain" 2>/dev/null | grep "v=spf")
    DKIM=$(host -t TXT "default._domainkey.$domain" 2>/dev/null | grep "v=DKIM")
    [ -n "$SPF" ]  && echo -e "  ${GREEN}✔ SPF: $SPF${RESET}"  || echo -e "  ${RED}✖ SPF não encontrado${RESET}"
    [ -n "$DKIM" ] && echo -e "  ${GREEN}✔ DKIM encontrado${RESET}" || echo -e "  ${YELLOW}⚠ DKIM não encontrado${RESET}"
}

# ============================================================
# VERSÕES ESTRUTURADAS (JSON) — usadas por --action=check-deliverability
# Não têm saída colorida; retornam fragmentos JSON prontos para compor
# a resposta de output_action_json(). Reaproveitam _detect_public_ip e
# _detect_domain acima — mesma lógica de detecção da versão interativa.
# ============================================================
check_blacklists_json() {
    local ip
    if ! ip=$(_detect_public_ip); then
        printf '"ip": null, "ip_error": "nao foi possivel determinar o IP publico do servidor"'
        return 1
    fi
    local rev_ip; rev_ip=$(echo "$ip" | awk -F. '{print $4"."$3"."$2"."$1}')
    local entries="" first=1 bl hit listed
    for bl in zen.spamhaus.org bl.spamcop.net dnsbl.sorbs.net b.barracudacentral.org; do
        hit=$(host -t A "${rev_ip}.${bl}" 2>/dev/null | grep -c "127\.")
        listed="false"; [ "$hit" -gt 0 ] && listed="true"
        [ "$first" -eq 1 ] || entries="${entries},"
        entries="${entries}{\"list\":\"${bl}\",\"listed\":${listed}}"
        first=0
    done
    printf '"ip": "%s", "blocklists": [%s]' "$ip" "$entries"
}

check_deliverability_json() {
    local domain="${1:-$(_detect_domain)}"
    local spf_found="false" dkim_found="false" dmarc_found="false"
    local spf_rec="" dkim_sel="default" dmarc_rec=""
    if command -v host &>/dev/null; then
        # `host -t TXT` imprime "<nome> descriptive text \"<conteudo>\"" —
        # extrai só o conteúdo entre aspas.
        spf_rec=$(host -t TXT "$domain" 2>/dev/null | grep "v=spf" | head -1 \
            | sed -E 's/^[^"]*"//; s/"$//')
        [ -n "$spf_rec" ] && spf_found="true"
        host -t TXT "default._domainkey.$domain" 2>/dev/null | grep -q "v=DKIM" && dkim_found="true"
        dmarc_rec=$(host -t TXT "_dmarc.$domain" 2>/dev/null | grep "v=DMARC" | head -1 \
            | sed -E 's/^[^"]*"//; s/"$//')
        [ -n "$dmarc_rec" ] && dmarc_found="true"
    fi
    spf_rec=$(printf '%s' "$spf_rec" | sed 's/"/\\"/g')
    dmarc_rec=$(printf '%s' "$dmarc_rec" | sed 's/"/\\"/g')
    printf '"domain": "%s", "spf": {"found": %s, "record": "%s"}, "dkim": {"found": %s, "selector": "%s"}, "dmarc": {"found": %s, "record": "%s"}' \
        "$domain" "$spf_found" "$spf_rec" "$dkim_found" "$dkim_sel" "$dmarc_found" "$dmarc_rec"
}

# Expiração do certificado TLS usado pelo STARTTLS na porta 25 (SMTP).
# "valid" só indica que um certificado foi obtido e parseado com sucesso —
# um cert já expirado ainda retorna valid:true com days_remaining negativo;
# quem decide o que fazer com isso (alertar, compor score) é quem consome
# o JSON, não este script (mesma separação de responsabilidade do resto
# de check_*_json — aqui só coleta dado estruturado).
check_cert_json() {
    local domain="${1:-$(_detect_domain)}"
    local enddate
    # -servername vazio faz o openssl abortar o handshake antes de expor o
    # cert ("Unable to set TLS servername extension") — sem domínio
    # detectado (ex.: servidor novo, sem histórico de log ainda), omite a
    # extensão SNI e usa o cert padrão do Exim.
    if [ -n "$domain" ]; then
        enddate=$(timeout 10 openssl s_client -starttls smtp -connect localhost:25 -servername "$domain" \
            </dev/null 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | sed -E 's/^notAfter=//')
    else
        enddate=$(timeout 10 openssl s_client -starttls smtp -connect localhost:25 \
            </dev/null 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | sed -E 's/^notAfter=//')
    fi
    if [ -z "$enddate" ]; then
        printf '"cert": {"valid": false, "days_remaining": null, "expires_at": null}'
        return
    fi
    local end_epoch now_epoch days_remaining expires_at
    end_epoch=$(date -d "$enddate" +%s 2>/dev/null)
    if [ -z "$end_epoch" ]; then
        printf '"cert": {"valid": false, "days_remaining": null, "expires_at": null}'
        return
    fi
    now_epoch=$(date +%s)
    days_remaining=$(( (end_epoch - now_epoch) / 86400 ))
    expires_at=$(date -u -d "$enddate" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)
    printf '"cert": {"valid": true, "days_remaining": %d, "expires_at": "%s"}' \
        "$days_remaining" "$expires_at"
}

# ============================================================
# STATUS DE BLOQUEIO POR IP — CSF / Imunify360 / MagicSpam
# Usadas por --action=check-ip-status e --action=unblock-ip.
# Cada helper retorna um fragmento JSON "<ferramenta>": {...} —
# mesma convenção de check_blacklists_json/check_deliverability_json.
# Ferramenta não instalada: só {"installed": false} (sem os demais campos).
# ============================================================
_ip_status_csf_json() {
    local ip="$1"
    if ! command -v "$EXIM_CSF_BIN" &>/dev/null; then
        printf '"csf": {"installed": false}'
        return
    fi
    local g_out; g_out=$($SUDO "$EXIM_CSF_BIN" -g "$ip" 2>&1)
    local blocked="false"
    printf '%s' "$g_out" | grep -qiE 'DROP|DENY|csf\.deny' && blocked="true"
    # csf -t lista os bloqueios temporários vigentes — se o IP não estiver
    # lá mas ainda assim bloqueado, é regra permanente (csf.deny/iptables).
    local type="none"
    if [ "$blocked" = "true" ]; then
        if $SUDO "$EXIM_CSF_BIN" -t 2>/dev/null | grep -qF "$ip"; then
            type="temp"
        else
            type="permanent"
        fi
    fi
    # Motivo do bloqueio — cruza com lfd.log, quando disponível
    local reason=""
    [ -r /var/log/lfd.log ] && reason=$(grep -F "$ip" /var/log/lfd.log 2>/dev/null | tail -1)
    local g_esc reason_esc
    g_esc=$(printf '%s' "$g_out" | tr '\n' ' ' | sed 's/"/\\"/g')
    reason_esc=$(printf '%s' "$reason" | sed 's/"/\\"/g')
    printf '"csf": {"installed": true, "blocked": %s, "type": "%s", "reason": "%s", "raw": "%s"}' \
        "$blocked" "$type" "$reason_esc" "$g_esc"
}

_ip_status_imunify_json() {
    local ip="$1"
    if ! command -v "$EXIM_IMUNIFY_BIN" &>/dev/null; then
        printf '"imunify360": {"installed": false}'
        return
    fi
    local out; out=$($SUDO "$EXIM_IMUNIFY_BIN" ip-list local list --by-ip "$ip" --json 2>&1)
    local blocked="false"
    printf '%s' "$out" | grep -qiE '"purpose"[[:space:]]*:[[:space:]]*"drop"' && blocked="true"
    local out_esc; out_esc=$(printf '%s' "$out" | tr '\n' ' ' | sed 's/"/\\"/g')
    printf '"imunify360": {"installed": true, "blocked": %s, "raw": "%s"}' "$blocked" "$out_esc"
}

# TODO: MagicSpam ainda não tem detecção de assinatura de log confirmada —
# o cliente já resolve desbloqueio direto no painel do MagicSpam, então
# esta ferramenta entra só como monitoramento/placeholder por enquanto.
# Não adivinhar o texto da mensagem de rejeição dele aqui: validar contra
# uma amostra real de log quando o cliente liberar acesso ao ambiente.
_ip_status_magicspam_json() {
    printf '"magicspam": {"installed": null, "note": "monitoramento via log - deteccao de assinatura pendente de validacao em ambiente real"}'
}

check_ip_status_json() {
    local ip="$1"
    local csf_json imun_json ms_json
    csf_json=$(_ip_status_csf_json "$ip")
    imun_json=$(_ip_status_imunify_json "$ip")
    ms_json=$(_ip_status_magicspam_json)
    printf '%s, %s, %s' "$csf_json" "$imun_json" "$ms_json"
}

find_php_mailers() {
    section "BUSCA DE SCRIPTS PHP MALICIOSOS"

    # ── Padrões suspeitos a procurar ────────────────────────────────────
    # Nível 1 — uso legítimo mas que pode ser abusado
    PAT_MAIL='mail\s*('
    # Nível 2 — fortemente suspeito: ofuscação, execução dinâmica, envio em massa
    PAT_SUSPECT='base64_decode\s*(\|eval\s*(\|str_rot13\s*(\|gzinflate\s*(\|gzuncompress\s*('
    PAT_SUSPECT="$PAT_SUSPECT"'|\$[a-zA-Z_]+\s*\(\s*\$[a-zA-Z_]'   # variável como função: $a($b)
    PAT_SUSPECT="$PAT_SUSPECT"'|fsockopen.*25\b'                      # socket direto porta 25
    PAT_SUSPECT="$PAT_SUSPECT"'|/\*[^*]{200,}\*/'                    # bloco de comentário gigante (ofuscação)
    # Nível 3 — headers típicos de spam injetados via PHP
    PAT_SPAM_HDR='Content-Type.*multipart\|MIME-Version\|X-Mailer\|Bcc:\|bcc:'

    # ── Descobrir domínios em /srv/ ──────────────────────────────────────
    SRV_BASE="/srv"
    DOMAINS=()
    if [ -d "$SRV_BASE" ]; then
        while IFS= read -r d; do
            # Cada subdiretório de /srv/ é um domínio/vhost
            DOMAINS+=("$d")
        done < <(find "$SRV_BASE" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)
    fi

    # Fallback legado
    [ -d /var/www ] && DOMAINS+=("/var/www")

    # cPanel/WHM: cada conta em /home/<usuario>/ vira uma entrada, usando
    # o nome da conta (basename) como identificador — nada de varrer
    # /home inteiro (pegaria caixas de e-mail e backups junto).
    if [ -d /home ]; then
        while IFS= read -r acct; do
            DOMAINS+=("$acct")
        done < <(find /home -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort)
    fi

    if [ ${#DOMAINS[@]} -eq 0 ]; then
        echo -e "  ${YELLOW}Nenhum diretório encontrado em $SRV_BASE, /var/www ou /home.${RESET}"
        return
    fi

    TOTAL_MAIL=0; TOTAL_SUSPECT=0

    for domain_dir in "${DOMAINS[@]}"; do
        # Dentro de cada domínio/conta, o webroot é preferencialmente
        # public_html (padrão cPanel/WHM) e, senão, www/ (padrão /srv)
        if [ -d "${domain_dir}/public_html" ]; then
            webroot="${domain_dir}/public_html"
        elif [ -d "${domain_dir}/www" ]; then
            webroot="${domain_dir}/www"
        else
            webroot="$domain_dir"
        fi

        domain_name=$(basename "$domain_dir")
        echo -e "\n  ${BOLD}${WHITE}▶ $domain_name${RESET}  ${DIM}($webroot)${RESET}"
        hr_thin

        # ── Nível CRÍTICO: padrões de ofuscação / mailer malicioso ──────
        echo -e "  ${LRED}[CRÍTICO] Ofuscação / execução dinâmica / socket SMTP:${RESET}"
        found_crit=0
        while IFS= read -r f; do
            [ -z "$f" ] && continue
            found_crit=1; TOTAL_SUSPECT=$((TOTAL_SUSPECT+1))
            mtime=$(stat -c '%y' "$f" 2>/dev/null | cut -d' ' -f1)
            size=$(stat -c '%s' "$f" 2>/dev/null)
            echo -e "    ${RED}✖${RESET} ${BOLD}$f${RESET}  ${DIM}(mod: $mtime  |  $size bytes)${RESET}"
        done < <(grep -rlE "$PAT_SUSPECT" "$webroot" --include='*.php' 2>/dev/null | sort)
        [ "$found_crit" -eq 0 ] && echo -e "    ${DIM}Nenhum encontrado.${RESET}"

        # ── Nível ALTO: uso de mail() com headers de spam ────────────────
        echo -e "\n  ${YELLOW}[ALTO] mail() com headers típicos de spam:${RESET}"
        found_hdr=0
        while IFS= read -r f; do
            [ -z "$f" ] && continue
            # Verifica se o mesmo arquivo também usa mail()
            grep -qE "$PAT_MAIL" "$f" 2>/dev/null || continue
            found_hdr=1; TOTAL_SUSPECT=$((TOTAL_SUSPECT+1))
            mtime=$(stat -c '%y' "$f" 2>/dev/null | cut -d' ' -f1)
            size=$(stat -c '%s' "$f" 2>/dev/null)
            echo -e "    ${YELLOW}⚠${RESET} ${BOLD}$f${RESET}  ${DIM}(mod: $mtime  |  $size bytes)${RESET}"
        done < <(grep -rlE "$PAT_SPAM_HDR" "$webroot" --include='*.php' 2>/dev/null | sort)
        [ "$found_hdr" -eq 0 ] && echo -e "    ${DIM}Nenhum encontrado.${RESET}"

        # ── Nível MÉDIO: qualquer uso de mail() ─────────────────────────
        echo -e "\n  ${CYAN}[MÉDIO] Arquivos com mail() (pode ser legítimo):${RESET}"
        found_mail=0
        while IFS= read -r f; do
            [ -z "$f" ] && continue
            found_mail=1; TOTAL_MAIL=$((TOTAL_MAIL+1))
            mtime=$(stat -c '%y' "$f" 2>/dev/null | cut -d' ' -f1)
            size=$(stat -c '%s' "$f" 2>/dev/null)
            # Conta quantas chamadas mail() tem no arquivo
            calls=$(grep -cE "$PAT_MAIL" "$f" 2>/dev/null)
            echo -e "    ${CYAN}·${RESET} $f  ${DIM}(mod: $mtime  |  $size bytes  |  ${calls}x mail())${RESET}"
        done < <(grep -rlE "$PAT_MAIL" "$webroot" --include='*.php' 2>/dev/null | sort | head -20)
        [ "$found_mail" -eq 0 ] && echo -e "    ${DIM}Nenhum encontrado.${RESET}"

        # ── Arquivos PHP modificados recentemente (últimas 48h) ──────────
        echo -e "\n  ${MAGENTA}[INFO] PHP modificado nas últimas 48h:${RESET}"
        found_recent=0
        while IFS= read -r f; do
            [ -z "$f" ] && continue
            found_recent=1
            mtime=$(stat -c '%y' "$f" 2>/dev/null | cut -d' ' -f1)
            echo -e "    ${MAGENTA}~${RESET} $f  ${DIM}(mod: $mtime)${RESET}"
        done < <(find "$webroot" -name '*.php' -newer /proc/1 -mtime -2 2>/dev/null | \
                 grep -v '/vendor/' | grep -v '/node_modules/' | sort | head -15)
        [ "$found_recent" -eq 0 ] && echo -e "    ${DIM}Nenhum arquivo PHP modificado recentemente.${RESET}"
    done

    # ── Resumo ───────────────────────────────────────────────────────────
    echo
    hr
    echo -e "  ${BOLD}Resumo:${RESET}"
    printf "  %-40s ${RED}%s${RESET}\n"    "Arquivos críticos/suspeitos:"  "$TOTAL_SUSPECT"
    printf "  %-40s ${CYAN}%s${RESET}\n"   "Arquivos com mail() (total):"  "$TOTAL_MAIL"
    echo
    echo -e "  ${DIM}Dica: para inspecionar um arquivo suspeito:${RESET}"
    echo -e "  ${DIM}  cat -A <arquivo> | head -50${RESET}"
    echo -e "  ${DIM}  php -l <arquivo>   (verifica sintaxe)${RESET}"
    echo -e "  ${DIM}Para ver quem está invocando mail() em tempo real:${RESET}"
    echo -e "  ${DIM}  strace -e trace=sendmsg -p \$(pgrep -n php-fpm) 2>&1 | grep -i mail${RESET}"
}
show_relay_detail() {
    echo -e "${BOLD}Mensagens From: $RELAY_SUSPECT${RESET}"
    echo "$QUEUE_RAW" | awk -v a="$RELAY_SUSPECT" '$1~/^[0-9]+[dhm]$/{ if($4~a) print }' | head -20
    echo
    echo -e "${BOLD}Bounces (<>) chegando para $RELAY_SUSPECT${RESET}"
    echo "$QUEUE_RAW" | awk -v a="$RELAY_SUSPECT" '$1~/^[0-9]+[dhm]$/{ if($4=="<>" && $5~a) print }' | head -20
}
show_last_log_errors() {
    echo "$LOG_SAMPLE" | grep -E ' (rejected|failed|error|SMTP error|panic|defer)' | tail -20
}

# ============================================================
# MENU
# ============================================================
print_menu() {
    section "AÇÕES DISPONÍVEIS"
    echo -e "  ${BOLD}${WHITE}── Diagnóstico ──────────────────────────────────────────${RESET}"
    echo -e "  ${CYAN}[b]${RESET} Verificar blacklists"
    echo -e "  ${CYAN}[s]${RESET} Verificar SPF / DKIM"
    echo -e "  ${CYAN}[e]${RESET} Últimos erros do log"
    echo -e "  ${CYAN}[v]${RESET} Ver fila completa (paginado)"
    echo -e "  ${CYAN}[h]${RESET} Tráfego por hora (últimas ${HOURS_WINDOW}h)"
    [ "$PROBLEM" = "SPAM_RELAY" ] && echo -e "  ${CYAN}[d]${RESET} Detalhar mensagens do relay suspeito"
    echo -e "  ${CYAN}[p]${RESET} Procurar scripts PHP com mail()"
    echo
    echo -e "  ${BOLD}${WHITE}── Limpeza ──────────────────────────────────────────────${RESET}"
    case "$PROBLEM" in
        SPAM_RELAY)
            echo -e "  ${RED}[1]${RESET} Limpar TODA a fila"
            echo -e "  ${RED}[2]${RESET} Limpar apenas bounces (<>)"
            [ -n "$TOP_IP" ] && echo -e "  ${YELLOW}[3]${RESET} Bloquear IP (iptables + firewall.d): ${BOLD}$TOP_IP${RESET}"
            ;;
        BOUNCE_CONCENTRADO)
            echo -e "  ${RED}[1]${RESET} Limpar bounces (<>)"
            echo -e "  ${YELLOW}[2]${RESET} Limpar toda a fila"
            ;;
        ENVIO_THROTTLED)
            echo -e "  ${CYAN}[1]${RESET} Forçar reprocessamento da fila (retentar entregas)"
            echo -e "  ${CYAN}[2]${RESET} Ver detalhes de deferimentos"
            echo -e "  ${DIM}[3]${RESET} Limpar fila do remetente: ${BOLD}$TOP_SENDER${RESET} ${DIM}(use com cuidado — envio legítimo)${RESET}"
            ;;
        SPAM_MASSIVO)
            echo -e "  ${RED}[1]${RESET} Limpar toda a fila"
            echo -e "  ${RED}[2]${RESET} Limpar fila do remetente: ${BOLD}$TOP_SENDER${RESET}"
            echo -e "  ${YELLOW}[3]${RESET} Limpar frozen"
            ;;
        AUTH_ABUSE)
            echo -e "  ${RED}[1]${RESET} Limpar fila de: ${BOLD}$TOP_AUTH_USER${RESET}"
            echo -e "  ${YELLOW}[2]${RESET} Limpar frozen"
            ;;
        IP_FLOOD)
            echo -e "  ${RED}[1]${RESET} Bloquear IP (iptables + firewall.d): ${BOLD}$TOP_IP${RESET}"
            echo -e "  ${YELLOW}[2]${RESET} Limpar toda a fila"
            echo -e "  ${YELLOW}[3]${RESET} Limpar frozen"
            ;;
        FILA_TRAVADA)
            echo -e "  ${YELLOW}[1]${RESET} Remover frozen"
            echo -e "  ${CYAN}[2]${RESET} Forçar reprocessamento (exim -qff)"
            ;;
        ALTO_DEFERIMENTO|BOUNCE_STORM|ALTA_REJEICAO)
            echo -e "  ${YELLOW}[1]${RESET} Limpar bounces (<>)"
            echo -e "  ${YELLOW}[2]${RESET} Limpar frozen"
            echo -e "  ${CYAN}[3]${RESET} Forçar reprocessamento"
            ;;
        FILA_ALTA|NORMAL)
            echo -e "  ${CYAN}[1]${RESET} Forçar reprocessamento"
            echo -e "  ${CYAN}[2]${RESET} Limpar frozen"
            ;;
    esac
    echo
    echo -e "  ${BOLD}${WHITE}── Geral ────────────────────────────────────────────────${RESET}"
    echo -e "  ${CYAN}[r]${RESET} Recarregar diagnóstico"
    echo -e "  ${RED}[x]${RESET} ${BOLD}Limpar TODA a fila${RESET} ${DIM}(${QUEUE} msgs)${RESET}"
    echo -e "  ${DIM}[0]${RESET} Sair"
    echo
    read -rp "  Escolha: " opt
    case "$opt" in
        b) check_blacklists;    read -rp "  [Enter]" ;;
        s) check_dkim_spf;      read -rp "  [Enter]" ;;
        e) show_last_log_errors | less -R ;;
        v) "$EXIM_BIN" -bp 2>/dev/null | less -R ;;
        h) print_hourly_stats;  read -rp "  [Enter para continuar]" ;;
        d) [ "$PROBLEM" = "SPAM_RELAY" ] && show_relay_detail | less -R ;;
        p) find_php_mailers;    read -rp "  [Enter]" ;;
        r) main; return ;;
        0)
            maybe_delete_script "antes de sair"
            echo; exit 0 ;;
        x|X)
            echo -e "\n  ${BGRED}${BOLD}  ATENÇÃO: esta ação remove TODAS as ${QUEUE} mensagens da fila.  ${RESET}"
            read -rp "  Confirma? [s/N]: " confirm
            if [[ "$confirm" =~ ^[sS]$ ]]; then
                clean_full
            else
                echo -e "  ${DIM}Cancelado.${RESET}"
            fi
            read -rp "  [Enter]" ;;
        1)
            case "$PROBLEM" in
                SPAM_RELAY)                                  clean_full ;;
                BOUNCE_CONCENTRADO)                          clean_bounces ;;
                SPAM_MASSIVO)                                clean_full ;;
                AUTH_ABUSE)                                  clean_by_auth_user "$TOP_AUTH_USER" ;;
                IP_FLOOD)                                    block_ip_firewall_d "$TOP_IP" ;;
                FILA_TRAVADA)                                clean_frozen ;;
                ALTO_DEFERIMENTO|BOUNCE_STORM|ALTA_REJEICAO) clean_bounces ;;
                FILA_ALTA|NORMAL)                            retry_queue ;;
            esac; read -rp "  [Enter]" ;;
        2)
            case "$PROBLEM" in
                SPAM_RELAY)                                  clean_bounces ;;
                BOUNCE_CONCENTRADO)                          clean_full ;;
                ENVIO_THROTTLED)                             { print_defers; read -rp "  [Enter para continuar]"; } ;;
                SPAM_MASSIVO)                                clean_by_sender "$TOP_SENDER" ;;
                AUTH_ABUSE)                                  clean_frozen ;;
                IP_FLOOD)                                    clean_full ;;
                FILA_TRAVADA)                                retry_queue ;;
                ALTO_DEFERIMENTO|BOUNCE_STORM|ALTA_REJEICAO) clean_frozen ;;
                FILA_ALTA|NORMAL)                            clean_frozen ;;
            esac; read -rp "  [Enter]" ;;
        3)
            case "$PROBLEM" in
                SPAM_RELAY)    [ -n "$TOP_IP" ] && block_ip_firewall_d "$TOP_IP" ;;
                ENVIO_THROTTLED)                             clean_by_sender "$TOP_SENDER" ;;
                SPAM_MASSIVO)  clean_frozen ;;
                IP_FLOOD)      clean_frozen ;;
                ALTO_DEFERIMENTO|BOUNCE_STORM|ALTA_REJEICAO) retry_queue ;;
                FILA_TRAVADA|BOUNCE_CONCENTRADO|FILA_ALTA|NORMAL) "$EXIM_BIN" -bp 2>/dev/null | less -R ;;
            esac; read -rp "  [Enter]" ;;
        *) echo -e "  ${DIM}Opção inválida.${RESET}"; sleep 1 ;;
    esac
    print_menu
}

auto_clean() {
    [ "$CLEAN_SPAM_AUTO" -eq 0 ] && return
    case "$PROBLEM" in
        SPAM_RELAY|SPAM_MASSIVO)    echo "[AUTO] Limpando fila..."; clean_full ;;
        BOUNCE_CONCENTRADO)         echo "[AUTO] Limpando bounces..."; clean_bounces ;;
    esac
}

main() {
    check_deps

    # ── Modo --check: verifica pré-requisitos do servidor (T2-3) ────
    if [ "$CHECK_MODE" -eq 1 ]; then
        run_check
        exit 0
    fi

    # ── Modo --action: executa ação pontual e sai imediatamente ────
    if [ -n "$ACTION_CMD" ]; then
        execute_action "$ACTION_CMD" "$ACTION_PARAM"
        exit $?
    fi

    get_server_ips
    detect_exim_version

    [ "$JSON_MODE" -eq 0 ] && print_header

    collect

    if [ "$QUICK_MODE" -eq 1 ]; then
        analyze_log
        analyze_suspicious_tlds
        analyze_hourly_stats
        TOP_SENDER=""; TOP_SENDER_COUNT=0
        BOUNCE_COUNT=0; TOP_RECIPIENT=""; TOP_RECIPIENT_COUNT=0
        RELAY_SUSPECT=""; RELAY_SUSPECT_SEND=0; RELAY_SUSPECT_BOUNCE=0
        OLD_DAYS=0
        classify
        output_json
        exit 0
    fi

    [ "$JSON_MODE" -eq 1 ] && {
        analyze_senders; analyze_recipients; analyze_log
        analyze_suspicious_tlds
        analyze_defers;  analyze_age;        analyze_php_mailers_json
        classify
        output_json; exit 0
    }

    _prog() { [ "$AUTO_MODE" -eq 0 ] && printf "  ${DIM}▸ %s...${RESET}\r" "$1"; }

    _prog "analisando remetentes e destinatários"
    analyze_senders
    analyze_recipients

    _prog "analisando log de entrega"
    analyze_log
    analyze_suspicious_tlds
    analyze_defers
    analyze_hourly_stats

    _prog "classificando cenário"
    analyze_age
    classify
    printf "\r%-60s\r" " "

    print_status
    print_diagnosis
    print_age

    print_senders
    print_recipients
    print_auth
    print_ips
    [ "$DEFER_COUNT" -gt 200 ] && [ "${DEFER_DETAIL_AVAILABLE:-0}" -eq 1 ] && print_defers

    auto_clean
    [ "$AUTO_MODE" -eq 0 ] && print_menu
}

main
