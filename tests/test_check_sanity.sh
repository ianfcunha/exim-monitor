#!/usr/bin/env bash
# ============================================================
# Teste de aceite — Sessão 4, Tarefas 1/2/3 (lado do script).
#
# Cada asserção aqui usa o DADO REAL que causou o defeito, não um caso
# inventado:
#
#   - "127.255.255.254" é a resposta que a zen.spamhaus.org devolveu de
#     verdade para 248.43.102.190.zen.spamhaus.org neste ambiente. É uma
#     RECUSA de consulta, e era lida como listagem — a origem do INC-59
#     e do "entrou e saiu da blocklist 12 vezes em 12 horas".
#
#   - ";; communications error to 127.0.0.1#53: connection refused" é a
#     saída real do dig quando não há resolver local. Contém "127.0.0.1"
#     e era casada como se fosse resposta da zona.
#
#   - "Jan  1 02:00:00 1970 GMT" é o notAfter real do certificado
#     autogerado do Exim desta máquina, que virou "expirado há 20.687
#     dias" (~56 anos) convivendo com "certificado válido: sim" no
#     mesmo card — a contradição que originou o INC-58.
#
# Técnica: `source` numa cópia do script com a chamada final a `main`
# neutralizada (mesmo padrão de tests/test_menu_dedup.sh), para chamar
# as funções internas diretamente.
# ============================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIAG="$SCRIPT_DIR/diag-exim/diag-exim.sh"
SOURCEABLE="$(mktemp)"

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  OK   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }
cleanup() { rm -f "$SOURCEABLE"; }
trap cleanup EXIT

sed '$ s/^main$/: # disabled/' "$DIAG" > "$SOURCEABLE"
# shellcheck disable=SC1090
source "$SOURCEABLE"

echo "── Sessão 4, T3: classificação de resposta DNSBL ──────────────"

REFUSED="127.255.255.254"
if _dnsbl_is_refused "$REFUSED"; then
    ok "127.255.255.254 (resposta real da zen.spamhaus.org aqui) é reconhecida como recusa"
else
    fail "127.255.255.254 NÃO foi reconhecida como recusa — voltaria a virar 'listado'"
fi

for addr in 127.255.255.0 127.255.255.1 127.255.255.255; do
    if _dnsbl_is_refused "$addr"; then ok "faixa de recusa cobre $addr"
    else fail "faixa de recusa não cobre $addr"; fi
done

if _dnsbl_is_refused "127.0.0.2"; then
    fail "127.0.0.2 (listagem legítima) foi classificada como recusa"
else
    ok "127.0.0.2 (listagem legítima) não é confundida com recusa"
fi

echo
echo "── Sessão 4, T3: erro de resolver não pode virar resposta ─────"

DIG_ERR=';; communications error to 127.0.0.1#53: connection refused'
ANSWERS="$(_dnsbl_answers "$DIG_ERR")"
if [ -z "$(printf '%s' "$ANSWERS" | tr -d '[:space:]')" ]; then
    ok "saída de erro do dig não produz nenhum endereço de resposta"
else
    fail "erro do dig extraído como resposta ('$ANSWERS') — falha de resolver viraria 'listado'"
fi

if _dnsbl_has_error "$DIG_ERR"; then
    ok "saída de erro do dig é reconhecida como falha de transporte"
else
    fail "erro do dig não reconhecido — a zona seria dada como 'limpa'"
fi

if [ "$(_dnsbl_answers '127.0.0.2')" = "127.0.0.2" ]; then
    ok "resposta pura do dig +short é extraída como endereço"
else
    fail "resposta pura do dig +short não foi extraída"
fi

HOST_FMT='248.43.102.190.zen.spamhaus.org has address 127.0.0.4'
if [ "$(_dnsbl_answers "$HOST_FMT")" = "127.0.0.4" ]; then
    ok "formato do host(1) ('has address X') é extraído como endereço"
else
    fail "formato do host(1) não foi extraído (fallback sem dig ficaria cego)"
fi

echo
echo "── Sessão 4, T1/T2: certificado TLS ao vivo ───────────────────"

CERT_JSON="$(check_cert_json)"
# check_cert_json imprime um fragmento '"cert": {...}' — embrulha pra virar JSON válido
CERT_FULL="$(printf '{%s}' "$CERT_JSON")"

if printf '%s' "$CERT_FULL" | python3 -m json.tool >/dev/null 2>&1; then
    ok "JSON do certificado é válido"
else
    fail "JSON do certificado é inválido: $CERT_FULL"
fi

read -r C_STATUS C_DAYS C_HOST C_SRC C_REASON <<<"$(printf '%s' "$CERT_FULL" | python3 -c "
import json,sys
c = json.load(sys.stdin)['cert']
print(c.get('status'), c.get('days_remaining'), c.get('hostname'), c.get('hostname_source'), '|' + (c.get('reason') or ''))
")"

echo "     status=$C_STATUS days=$C_DAYS hostname=$C_HOST origem=$C_SRC"

# Contradição interna proibida (T1): nenhum caminho pode afirmar
# "certificado válido" e "certificado expirado" ao mesmo tempo.
if printf '%s' "$CERT_FULL" | python3 -c "
import json,sys
c = json.load(sys.stdin)['cert']
sys.exit(0 if not (c.get('valid') is True and c.get('expired') is True) else 1)
"; then
    ok "não coexistem 'válido' e 'expirado' no mesmo resultado"
else
    fail "contradição interna: certificado marcado como válido E expirado"
fi

# Sanidade obrigatória (T1): fora de [-3650, 3650] o resultado é desconhecido.
if printf '%s' "$CERT_FULL" | python3 -c "
import json,sys
c = json.load(sys.stdin)['cert']
d = c.get('days_remaining')
if d is None:
    sys.exit(0)
sys.exit(0 if -3650 <= d <= 3650 else 1)
"; then
    ok "days_remaining está dentro de [-3650, 3650] ou é null"
else
    fail "days_remaining fora da faixa de sanidade — 'expirado há 56 anos' voltaria"
fi

if [ "$C_STATUS" = "desconhecido" ]; then
    if [ -n "$C_REASON" ] && [ "$C_REASON" != "|" ]; then
        ok "status 'desconhecido' vem acompanhado de motivo: ${C_REASON#|}"
    else
        fail "status 'desconhecido' sem motivo — a interface não teria o que explicar"
    fi
elif [ "$C_STATUS" = "ok" ]; then
    ok "certificado verificável neste host (status ok)"
else
    fail "status inesperado do certificado: '$C_STATUS'"
fi

# T2: o hostname usado nunca pode ser um IP.
if printf '%s' "$C_HOST" | grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
    fail "hostname usado para SNI é um IP ('$C_HOST') — exatamente o defeito do INC-58"
else
    ok "hostname usado para SNI não é um IP ('$C_HOST', origem: $C_SRC)"
fi

echo
echo "── Sessão 4, T1: aceite — sem hostname, resultado é desconhecido ──"

# Aceite literal da Tarefa 1: apontar o checador para um IP sem SNI e o
# resultado ser "não foi possível verificar", sem incidente.
IP_JSON="$(printf '{%s}' "$(check_cert_json "203.0.113.7")")"
if printf '%s' "$IP_JSON" | python3 -c "
import json,sys
c = json.load(sys.stdin)['cert']
h = c.get('hostname') or ''
import re
sys.exit(1 if re.match(r'^\d{1,3}(\.\d{1,3}){3}$', h) else 0)
"; then
    ok "um IP passado como parâmetro não é aceito como hostname de SNI"
else
    fail "um IP passado como parâmetro virou hostname de SNI"
fi

echo
echo "── Guarda estática: o padrão quebrado não pode voltar ─────────"

if grep -nE 'grep -c "127\\\\\."' "$DIAG" >/dev/null 2>&1; then
    fail "voltou o 'grep -c \"127\\.\"' contra a saída inteira da consulta DNSBL"
else
    ok "não há mais contagem de '127.' sobre a saída bruta da consulta"
fi

if grep -n '"cert": {"valid": true' "$DIAG" >/dev/null 2>&1; then
    fail "voltou o campo 'valid' afirmativo no JSON do certificado"
else
    ok "o JSON do certificado não emite mais um 'valid' que significa só 'consegui parsear'"
fi

echo
echo "════════════════════════════════════════════════════════"
echo "  PASS: $PASS   FAIL: $FAIL"
echo "════════════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ]
