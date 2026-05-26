#!/usr/bin/env bash
# =============================================================================
# exim-test.sh — Injetor e validador de tráfego para o EXIM Monitor
#
# Uso:
#   bash exim-test.sh [OPÇÕES]
#
# Opções:
#   -n NUM       Número de mensagens a injetar (padrão: 10)
#   -d DOMAIN    Domínio de destino (padrão: test-invalid.local → gera deferred)
#   -s SENDER    Remetente (padrão: test@exim-monitor.local)
#   --freeze     Injeta mensagens e as congela imediatamente (frozen)
#   --clean      Remove TODAS as mensagens de teste injetadas por este script
#   --watch      Apenas observa a fila a cada 5s sem injetar nada
#   --compare    Compara output do diag-exim.sh com a API REST
#
# Exemplos:
#   bash exim-test.sh -n 20                  # injeta 20 mensagens deferred
#   bash exim-test.sh -n 5 --freeze          # injeta 5 e as congela
#   bash exim-test.sh --clean                # limpa as mensagens de teste
#   bash exim-test.sh --watch                # monitora a fila em tempo real
#   bash exim-test.sh --compare              # compara diag vs API
# =============================================================================

set -euo pipefail

# ── Cores ──────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

# ── Defaults ───────────────────────────────────────────────────────────────────
N=10
DOMAIN="test-invalid.exim-monitor.local"
SENDER="test-inject@exim-monitor.local"
MODE="inject"         # inject | clean | watch | compare
FREEZE=false
API_URL="http://127.0.0.1:8000"
DIAG_SCRIPT="/root/exim-monitor/diag-exim.sh"
TEST_TAG="EXIM-MONITOR-TEST"    # tag única para identificar msgs injetadas

# ── Parse de args ──────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        -n)       N="$2";            shift 2 ;;
        -d)       DOMAIN="$2";       shift 2 ;;
        -s)       SENDER="$2";       shift 2 ;;
        --freeze) FREEZE=true;       shift ;;
        --clean)  MODE="clean";      shift ;;
        --watch)  MODE="watch";      shift ;;
        --compare) MODE="compare";   shift ;;
        *) echo "Opção desconhecida: $1"; exit 1 ;;
    esac
done

# ── Helpers ────────────────────────────────────────────────────────────────────
info()    { echo -e "${CYAN}${BOLD}[INFO]${RESET}  $*"; }
ok()      { echo -e "${GREEN}${BOLD}[ OK ]${RESET}  $*"; }
warn()    { echo -e "${YELLOW}${BOLD}[WARN]${RESET}  $*"; }
err()     { echo -e "${RED}${BOLD}[ERRO]${RESET}  $*"; }
sep()     { echo -e "${DIM}────────────────────────────────────────────${RESET}"; }

check_deps() {
    for cmd in exim curl jq; do
        if ! command -v "$cmd" &>/dev/null; then
            warn "$cmd não encontrado — algumas funções podem não funcionar"
        fi
    done
}

queue_count() {
    exim -bpc 2>/dev/null || echo "?"
}

# ── MODO: injetar mensagens ────────────────────────────────────────────────────
inject() {
    info "Injetando ${BOLD}$N${RESET} mensagens de teste na fila do EXIM..."
    info "Remetente : $SENDER"
    info "Destino   : user@$DOMAIN (domínio inválido → deferred automático)"
    sep

    BEFORE=$(queue_count)
    info "Fila antes da injeção: ${BOLD}$BEFORE${RESET} mensagens"
    sep

    INJECTED=0
    for i in $(seq 1 "$N"); do
        RECIPIENT="recipient-${i}@${DOMAIN}"
        MSG_BODY="From: $SENDER
To: $RECIPIENT
Subject: [$TEST_TAG] Mensagem de teste #$i
X-Test-Tag: $TEST_TAG
X-Test-Seq: $i
X-Test-Time: $(date -u +%Y-%m-%dT%H:%M:%SZ)

Esta é uma mensagem de teste injetada pelo exim-test.sh.
Sequência: $i de $N
Tag: $TEST_TAG

Esta mensagem ficará em DEFERRED pois o domínio destino é inválido.
Para remover todas as mensagens de teste: bash exim-test.sh --clean
"
        if echo "$MSG_BODY" | exim -bS 2>/dev/null; then
            INJECTED=$((INJECTED + 1))
            printf "  ${DIM}[%3d/%d]${RESET} injetada → %s\n" "$i" "$N" "$RECIPIENT"
        else
            warn "Falha ao injetar mensagem #$i"
        fi
    done

    sep
    ok "Injetadas: ${BOLD}$INJECTED${RESET} mensagens"

    # Congela se solicitado
    if $FREEZE; then
        info "Congelando mensagens de teste (--freeze)..."
        FROZEN=0
        while IFS= read -r msg_id; do
            if exim -Mf "$msg_id" 2>/dev/null; then
                FROZEN=$((FROZEN + 1))
            fi
        done < <(exiqgrep -s "$SENDER" -i 2>/dev/null || true)
        ok "Congeladas: ${BOLD}$FROZEN${RESET} mensagens"
    fi

    # Aguarda o diag-exim ser executado pelo coletor (~30s)
    echo ""
    info "Aguardando próxima coleta do dashboard (até 35s)..."
    for i in $(seq 1 7); do
        sleep 5
        CURRENT=$(queue_count)
        printf "  ${DIM}[%ds]${RESET} Fila atual: ${BOLD}%s${RESET}\n" "$((i * 5))" "$CURRENT"
    done

    AFTER=$(queue_count)
    sep
    echo -e "  Fila antes  : ${BOLD}$BEFORE${RESET}"
    echo -e "  Fila depois : ${BOLD}$AFTER${RESET}"
    DIFF=$((AFTER - BEFORE))
    if [ "$DIFF" -gt 0 ]; then
        ok "Delta: +${BOLD}$DIFF${RESET} mensagens na fila"
    else
        warn "Delta: $DIFF (possível coleta automática em andamento)"
    fi

    echo ""
    info "Verifique o dashboard — a fila deve refletir ~$AFTER mensagens."
    info "Para limpar: ${BOLD}bash exim-test.sh --clean${RESET}"
}

# ── MODO: limpar mensagens de teste ───────────────────────────────────────────
clean() {
    info "Removendo mensagens de teste (tag: $TEST_TAG)..."
    sep

    REMOVED=0
    while IFS= read -r msg_id; do
        if exim -Mrm "$msg_id" 2>/dev/null; then
            REMOVED=$((REMOVED + 1))
            echo -e "  ${DIM}removida${RESET} $msg_id"
        fi
    done < <(exiqgrep -s "$SENDER" -i 2>/dev/null | grep -E '^[A-Za-z0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+$' || true)

    sep
    ok "Removidas: ${BOLD}$REMOVED${RESET} mensagens de teste"
    info "Fila atual: ${BOLD}$(queue_count)${RESET}"
}

# ── MODO: watch (monitorar fila) ───────────────────────────────────────────────
watch_queue() {
    info "Monitorando fila EXIM (Ctrl+C para parar)..."
    sep
    while true; do
        TS=$(date '+%H:%M:%S')
        TOTAL=$(exim -bpc 2>/dev/null || echo "?")
        FROZEN=$(exiqgrep -z -i 2>/dev/null | wc -l || echo "?")
        BOUNCE=$(exiqgrep -f '<>' -i 2>/dev/null | wc -l || echo "?")
        printf "  ${DIM}[%s]${RESET}  Total: ${BOLD}%-6s${RESET}  Frozen: ${BOLD}%-6s${RESET}  Bounces: ${BOLD}%-6s${RESET}\n" \
            "$TS" "$TOTAL" "$FROZEN" "$BOUNCE"
        sleep 5
    done
}

# ── MODO: comparar diag-exim.sh vs API ────────────────────────────────────────
compare() {
    info "Comparando output do diag-exim.sh com a API REST..."
    sep

    # Obtém token JWT
    echo -ne "  ${DIM}Login na API...${RESET} "
    TOKEN_RESP=$(curl -s -X POST "$API_URL/api/auth/login" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        -d "username=admin&password=${ADMIN_PASSWORD:-}" 2>/dev/null || echo "{}")
    TOKEN=$(echo "$TOKEN_RESP" | jq -r '.access_token // empty' 2>/dev/null || true)

    if [ -z "$TOKEN" ]; then
        warn "Não foi possível obter token JWT."
        warn "Defina ADMIN_PASSWORD=<senha> antes de rodar --compare"
        warn "Exemplo: ADMIN_PASSWORD=suasenha bash exim-test.sh --compare"
        echo ""
        warn "Comparando apenas via diag-exim.sh (sem API)..."
    else
        echo -e "${GREEN}OK${RESET}"
    fi

    # Roda diag-exim.sh diretamente
    echo -ne "  ${DIM}Executando diag-exim.sh --json...${RESET} "
    if [ ! -f "$DIAG_SCRIPT" ]; then
        err "Script não encontrado: $DIAG_SCRIPT"
        exit 1
    fi
    DIAG_OUT=$(bash "$DIAG_SCRIPT" --json 2>/dev/null)
    echo -e "${GREEN}OK${RESET}"

    # Parseia métricas do diag
    DIAG_QUEUE=$(echo "$DIAG_OUT"    | jq -r '.queue_total    // "?"' 2>/dev/null)
    DIAG_SEV=$(echo "$DIAG_OUT"      | jq -r '.severity       // "?"' 2>/dev/null)
    DIAG_DELIVERED=$(echo "$DIAG_OUT" | jq -r '.delivered     // "?"' 2>/dev/null)
    DIAG_REJECTED=$(echo "$DIAG_OUT"  | jq -r '.rejected      // "?"' 2>/dev/null)
    DIAG_DEFERRED=$(echo "$DIAG_OUT"  | jq -r '.deferred      // "?"' 2>/dev/null)

    # Obtém dados da API
    API_QUEUE="?"; API_SEV="?"; API_DELIVERED="?"; API_REJECTED="?"; API_DEFERRED="?"
    if [ -n "$TOKEN" ]; then
        echo -ne "  ${DIM}Consultando API /status/full...${RESET} "
        API_OUT=$(curl -s "$API_URL/api/status/full" \
            -H "Authorization: Bearer $TOKEN" 2>/dev/null || echo "{}")
        echo -e "${GREEN}OK${RESET}"

        API_QUEUE=$(echo "$API_OUT"     | jq -r '.queue_total    // "?"' 2>/dev/null)
        API_SEV=$(echo "$API_OUT"       | jq -r '.severity       // "?"' 2>/dev/null)
        API_DELIVERED=$(echo "$API_OUT"  | jq -r '.delivered     // "?"' 2>/dev/null)
        API_REJECTED=$(echo "$API_OUT"   | jq -r '.rejected      // "?"' 2>/dev/null)
        API_DEFERRED=$(echo "$API_OUT"   | jq -r '.deferred      // "?"' 2>/dev/null)
    fi

    sep
    printf "  %-20s  %15s  %15s  %s\n" "MÉTRICA" "diag-exim.sh" "API /status/full" "STATUS"
    sep

    compare_metric() {
        local label="$1" val_diag="$2" val_api="$3"
        if [ "$val_api" = "?" ]; then
            printf "  %-20s  %15s  %15s  ${DIM}(sem token)${RESET}\n" "$label" "$val_diag" "$val_api"
        elif [ "$val_diag" = "$val_api" ]; then
            printf "  %-20s  %15s  %15s  ${GREEN}✓ bate${RESET}\n" "$label" "$val_diag" "$val_api"
        else
            printf "  %-20s  %15s  %15s  ${YELLOW}△ diferença${RESET}\n" "$label" "$val_diag" "$val_api"
        fi
    }

    compare_metric "Fila total"   "$DIAG_QUEUE"     "$API_QUEUE"
    compare_metric "Severidade"   "$DIAG_SEV"       "$API_SEV"
    compare_metric "Entregues"    "$DIAG_DELIVERED"  "$API_DELIVERED"
    compare_metric "Rejeitados"   "$DIAG_REJECTED"   "$API_REJECTED"
    compare_metric "Deferidos"    "$DIAG_DEFERRED"   "$API_DEFERRED"

    sep
    echo ""
    info "Nota: diferenças pequenas são normais se houve nova coleta entre as duas"
    info "chamadas (~30s de defasagem). Para mínima variação, use imediatamente"
    info "após um refresh manual no dashboard."

    # Exibe resumo do diag
    echo ""
    info "Resumo completo do diag-exim.sh:"
    echo "$DIAG_OUT" | jq '{queue_total,severity,problem,delivered,rejected,deferred,recent_sends}' 2>/dev/null || \
        echo "$DIAG_OUT" | head -20
}

# ── Execução ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${CYAN}║     EXIM Monitor — Script de Teste           ║${RESET}"
echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════╝${RESET}"
echo ""

check_deps

case "$MODE" in
    inject)  inject      ;;
    clean)   clean       ;;
    watch)   watch_queue ;;
    compare) compare     ;;
esac

echo ""
