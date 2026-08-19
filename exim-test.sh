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
#   --size SIZE  Preenche o corpo de cada mensagem até ~SIZE (aceita sufixo
#                K/M, ex.: 500K, 6M) — sem isso as mensagens ficam com
#                poucas centenas de bytes. Usado para validar a distribuição
#                de tamanho da fila (queue.size_distribution no --json).
#   --freeze     Injeta mensagens e as congela imediatamente (frozen)
#   --clean      Remove TODAS as mensagens de teste injetadas por este script
#   --watch      Apenas observa a fila a cada 5s sem injetar nada
#   --compare    Compara output do diag-exim.sh com a API REST
#
# Exemplos:
#   bash exim-test.sh -n 20                  # injeta 20 mensagens deferred
#   bash exim-test.sh -n 5 --freeze          # injeta 5 e as congela
#   bash exim-test.sh -n 3 --size 6M         # injeta 3 mensagens de ~6MB
#   bash exim-test.sh --clean                # limpa as mensagens de teste
#   bash exim-test.sh --watch                # monitora a fila em tempo real
#   ADMIN_PASSWORD=senha bash exim-test.sh --compare
# =============================================================================

set -euo pipefail

# ── Cores ──────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

# ── Defaults ───────────────────────────────────────────────────────────────────
N=10
DOMAIN="test-invalid.exim-monitor.local"
SENDER="test-inject@exim-monitor.local"
MODE="inject"
FREEZE=false
SIZE=""
API_URL="http://127.0.0.1:8000"
DIAG_SCRIPT="/root/exim-monitor/diag-exim.sh"
TEST_TAG="EXIM-MONITOR-TEST"

# ── Parse de args ──────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        -n)        N="$2";           shift 2 ;;
        -d)        DOMAIN="$2";      shift 2 ;;
        -s)        SENDER="$2";      shift 2 ;;
        --size)    SIZE="$2";        shift 2 ;;
        --freeze)  FREEZE=true;      shift   ;;
        --clean)   MODE="clean";     shift   ;;
        --watch)   MODE="watch";     shift   ;;
        --compare) MODE="compare";   shift   ;;
        *) echo "Opcao desconhecida: $1"; exit 1 ;;
    esac
done

# Converte "500K"/"6M"/bytes puro para um número de bytes.
_size_to_bytes() {
    local s="$1"
    case "$s" in
        *[Kk]) echo $(( ${s%[Kk]} * 1024 )) ;;
        *[Mm]) echo $(( ${s%[Mm]} * 1024 * 1024 )) ;;
        *[Gg]) echo $(( ${s%[Gg]} * 1024 * 1024 * 1024 )) ;;
        *)     echo "$s" ;;
    esac
}

# ── Helpers ────────────────────────────────────────────────────────────────────
info() { echo -e "${CYAN}${BOLD}[INFO]${RESET}  $*"; }
ok()   { echo -e "${GREEN}${BOLD}[ OK ]${RESET}  $*"; }
warn() { echo -e "${YELLOW}${BOLD}[WARN]${RESET}  $*"; }
err()  { echo -e "${RED}${BOLD}[ERRO]${RESET}  $*"; }
sep()  { echo -e "${DIM}--------------------------------------------${RESET}"; }

check_deps() {
    for cmd in exim curl jq; do
        command -v "$cmd" &>/dev/null || warn "$cmd nao encontrado — algumas funcoes podem nao funcionar"
    done
}

queue_count() {
    exim -bpc 2>/dev/null || echo "?"
}

# ── MODO: injetar mensagens ────────────────────────────────────────────────────
inject() {
    info "Injetando ${BOLD}$N${RESET} mensagens de teste na fila do EXIM..."
    info "Remetente : $SENDER"
    info "Destino   : recipient-N@$DOMAIN (dominio invalido -> deferred)"
    sep

    BEFORE=$(queue_count)
    info "Fila antes da injecao: ${BOLD}$BEFORE${RESET} mensagens"

    # --size: gera um bloco de preenchimento uma unica vez e reaproveita em
    # todas as mensagens (evita recriar N vezes) — texto puro ('A' repetido),
    # seguro pra corpo de e-mail, sem depender de /dev/urandom+base64 (que
    # infla ~33% e complicaria acertar o tamanho exato).
    _PAD_FILE=""
    if [ -n "$SIZE" ]; then
        _PAD_BYTES=$(_size_to_bytes "$SIZE")
        _PAD_FILE=$(mktemp /tmp/eximtest_pad.XXXXXX)
        head -c "$_PAD_BYTES" /dev/zero | tr '\0' 'A' > "$_PAD_FILE"
        info "Preenchendo corpo de cada mensagem para ~${BOLD}$SIZE${RESET} (${_PAD_BYTES} bytes)"
    fi
    sep

    INJECTED=0
    for i in $(seq 1 "$N"); do
        RECIPIENT="recipient-${i}@${DOMAIN}"
        TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

        # -odq  = queue-only, nao tenta entrega imediata
        # -f    = define envelope sender
        # sem -odq, EXIM tenta DNS na hora e descarta como falha permanente (NXDOMAIN)
        if { printf '%s\n' \
            "Subject: [$TEST_TAG] Mensagem de teste #$i" \
            "From: $SENDER" \
            "To: $RECIPIENT" \
            "X-Test-Tag: $TEST_TAG" \
            "X-Test-Seq: $i" \
            "X-Test-Time: $TS" \
            "" \
            "Mensagem de teste #$i injetada pelo exim-test.sh" \
            "Tag: $TEST_TAG  |  Seq: $i/$N" \
            "Dominio destino invalido -> ficara em DEFERRED automaticamente." \
            "Para remover: bash exim-test.sh --clean"; \
            [ -n "$_PAD_FILE" ] && cat "$_PAD_FILE"; } \
            | exim -odq -f "$SENDER" "$RECIPIENT" 2>/dev/null; then
            INJECTED=$((INJECTED + 1))
            printf "  ${DIM}[%3d/%d]${RESET} injetada -> %s\n" "$i" "$N" "$RECIPIENT"
        else
            warn "Falha ao injetar mensagem #$i"
        fi
    done
    [ -n "$_PAD_FILE" ] && rm -f "$_PAD_FILE"

    sep
    ok "Injetadas: ${BOLD}$INJECTED${RESET} mensagens"

    if $FREEZE; then
        info "Congelando mensagens de teste (--freeze)..."
        FROZEN=0
        while IFS= read -r msg_id; do
            if exim -Mf "$msg_id" 2>/dev/null; then
                FROZEN=$((FROZEN + 1))
            fi
        done < <(exiqgrep -f "$SENDER" -i 2>/dev/null || true)
        ok "Congeladas: ${BOLD}$FROZEN${RESET} mensagens"
    fi

    echo ""
    info "Aguardando proxima coleta do dashboard (ate 35s)..."
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
        warn "Delta: $DIFF (possivel coleta automatica em andamento)"
    fi

    echo ""
    info "Verifique o dashboard — a fila deve refletir ~$AFTER mensagens."
    info "Para limpar: ${BOLD}bash exim-test.sh --clean${RESET}"
}

# ── MODO: limpar mensagens de teste ───────────────────────────────────────────
# FIX: usava "exiqgrep -s" (filtra pelo campo de TAMANHO, não sender —
# "-f" é o filtro de sender) — nunca encontrava as mensagens injetadas por
# este script, então --clean e o bloco --freeze de inject() sempre agiam
# sobre zero mensagens silenciosamente.
clean() {
    info "Removendo mensagens de teste (remetente: $SENDER)..."
    sep

    REMOVED=0
    while IFS= read -r msg_id; do
        if exim -Mrm "$msg_id" 2>/dev/null; then
            REMOVED=$((REMOVED + 1))
            echo -e "  ${DIM}removida${RESET} $msg_id"
        fi
    done < <(exiqgrep -f "$SENDER" -i 2>/dev/null \
        | grep -E '^[A-Za-z0-9]+-[A-Za-z0-9]+-[A-Za-z0-9]+$' || true)

    sep
    ok "Removidas: ${BOLD}$REMOVED${RESET} mensagens de teste"
    info "Fila atual: ${BOLD}$(queue_count)${RESET}"
}

# ── MODO: watch ────────────────────────────────────────────────────────────────
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

    echo -ne "  ${DIM}Login na API...${RESET} "
    TOKEN_RESP=$(curl -s -X POST "$API_URL/api/auth/login" \
        -H "Content-Type: application/x-www-form-urlencoded" \
        -d "username=admin&password=${ADMIN_PASSWORD:-}" 2>/dev/null || echo "{}")
    TOKEN=$(echo "$TOKEN_RESP" | jq -r '.access_token // empty' 2>/dev/null || true)

    if [ -z "$TOKEN" ]; then
        warn "Nao foi possivel obter token JWT."
        warn "Defina ADMIN_PASSWORD=<senha> antes: ADMIN_PASSWORD=sua_senha bash exim-test.sh --compare"
    else
        echo -e "${GREEN}OK${RESET}"
    fi

    echo -ne "  ${DIM}Executando diag-exim.sh --json...${RESET} "
    if [ ! -f "$DIAG_SCRIPT" ]; then
        err "Script nao encontrado: $DIAG_SCRIPT"
        exit 1
    fi
    DIAG_OUT=$(bash "$DIAG_SCRIPT" --json 2>/dev/null)
    echo -e "${GREEN}OK${RESET}"

    DIAG_QUEUE=$(echo "$DIAG_OUT"     | jq -r '.queue_total // "?"' 2>/dev/null)
    DIAG_SEV=$(echo "$DIAG_OUT"       | jq -r '.severity    // "?"' 2>/dev/null)
    DIAG_DELIVERED=$(echo "$DIAG_OUT" | jq -r '.delivered   // "?"' 2>/dev/null)
    DIAG_REJECTED=$(echo "$DIAG_OUT"  | jq -r '.rejected    // "?"' 2>/dev/null)
    DIAG_DEFERRED=$(echo "$DIAG_OUT"  | jq -r '.deferred    // "?"' 2>/dev/null)

    API_QUEUE="?"; API_SEV="?"; API_DELIVERED="?"; API_REJECTED="?"; API_DEFERRED="?"
    if [ -n "$TOKEN" ]; then
        echo -ne "  ${DIM}Consultando API /status/full...${RESET} "
        API_OUT=$(curl -s "$API_URL/api/status/full" \
            -H "Authorization: Bearer $TOKEN" 2>/dev/null || echo "{}")
        echo -e "${GREEN}OK${RESET}"

        API_QUEUE=$(echo "$API_OUT"     | jq -r '.queue_total // "?"' 2>/dev/null)
        API_SEV=$(echo "$API_OUT"       | jq -r '.severity    // "?"' 2>/dev/null)
        API_DELIVERED=$(echo "$API_OUT" | jq -r '.delivered   // "?"' 2>/dev/null)
        API_REJECTED=$(echo "$API_OUT"  | jq -r '.rejected    // "?"' 2>/dev/null)
        API_DEFERRED=$(echo "$API_OUT"  | jq -r '.deferred    // "?"' 2>/dev/null)
    fi

    sep
    printf "  %-18s  %16s  %16s  %s\n" "METRICA" "diag-exim.sh" "API /status/full" "STATUS"
    sep

    _cmp() {
        local label="$1" vd="$2" va="$3"
        if   [ "$va" = "?" ];    then printf "  %-18s  %16s  %16s  ${DIM}(sem token)${RESET}\n"     "$label" "$vd" "$va"
        elif [ "$vd" = "$va" ];  then printf "  %-18s  %16s  %16s  ${GREEN}bate${RESET}\n"          "$label" "$vd" "$va"
        else                          printf "  %-18s  %16s  %16s  ${YELLOW}diferenca${RESET}\n"    "$label" "$vd" "$va"
        fi
    }

    _cmp "Fila total"   "$DIAG_QUEUE"      "$API_QUEUE"
    _cmp "Severidade"   "$DIAG_SEV"        "$API_SEV"
    _cmp "Entregues"    "$DIAG_DELIVERED"  "$API_DELIVERED"
    _cmp "Rejeitados"   "$DIAG_REJECTED"   "$API_REJECTED"
    _cmp "Deferidos"    "$DIAG_DEFERRED"   "$API_DEFERRED"

    sep
    echo ""
    info "Nota: diferencas pequenas sao normais — ha ~30s de defasagem entre"
    info "a coleta do background_collector e o diag rodado agora."
    echo ""
    info "Resumo completo do diag-exim.sh:"
    echo "$DIAG_OUT" | jq \
        '{queue_total,severity,problem,delivered,rejected,deferred,recent_sends}' \
        2>/dev/null || echo "$DIAG_OUT" | head -20
}

# ── Execução principal ─────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${CYAN}+----------------------------------------------+${RESET}"
echo -e "${BOLD}${CYAN}|   EXIM Monitor — Script de Teste             |${RESET}"
echo -e "${BOLD}${CYAN}+----------------------------------------------+${RESET}"
echo ""

check_deps

case "$MODE" in
    inject)  inject      ;;
    clean)   clean       ;;
    watch)   watch_queue ;;
    compare) compare     ;;
esac

echo ""
