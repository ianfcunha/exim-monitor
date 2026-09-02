#!/usr/bin/env bash
# =============================================================================
# Guarda compartilhada: testes que CADASTRAM um servidor de teste.
#
# Desde o T6 (licença soft), POST /api/servers responde 403 quando a
# instalação está no teto de servidores ou com a licença vencida. Isso é o
# comportamento correto do produto — mas faz um teste de outra coisa
# (credencial ilegível, bootstrap, privilégios) falhar por um motivo que
# não tem nada a ver com o que ele mede, e o operador que rodar a suíte no
# próprio painel vai olhar para um vermelho enganoso.
#
# Então: pular explicitamente, dizendo o motivo e como liberar. Pular por
# um motivo nomeado é honesto; falhar por um motivo alheio, não.
#
# Uso, depois de ter $API_URL e $AUTH_H:
#     source "$(dirname "${BASH_SOURCE[0]}")/_license_guard.sh"
#     skip_if_license_blocks
# =============================================================================

skip_if_license_blocks() {
    local lic used max state
    lic=$(curl -s "$API_URL/api/license" -H "$AUTH_H" 2>/dev/null)
    # Sem o endpoint (build antiga) ou sem permissão: segue o teste.
    [ -z "$lic" ] && return 0
    # has(...), não `jq -e .can_add_server`: com o valor `false` o -e sai 1
    # e a guarda passaria batido justamente no caso que ela existe para pegar.
    echo "$lic" | jq -e 'has("can_add_server")' >/dev/null 2>&1 || return 0
    if [ "$(echo "$lic" | jq -r '.can_add_server')" = "true" ]; then
        return 0
    fi
    state=$(echo "$lic" | jq -r '.state')
    used=$(echo "$lic"  | jq -r '.servers_used')
    max=$(echo "$lic"   | jq -r '.max_servers')
    echo "PULANDO — a licença desta instalação não permite cadastrar mais servidores"
    echo "  estado: $state ($used de $max em uso)"
    echo "  motivo: $(echo "$lic" | jq -r '.block_reason')"
    echo "  Este teste precisa criar um servidor descartável. Para rodá-lo, use uma"
    echo "  instalação com folga no limite ou uma licença de teste em MAILIQ_LICENSE."
    exit 0
}
