#!/usr/bin/env bash
# =============================================================================
# T6 — Licença soft: assinatura, estados e o ÚNICO bloqueio (cadastro).
#
# Autocontido: não precisa do stack de dev, nem de banco, nem de rede.
# Roda a lógica de licença direto (python3 + cryptography) e prova:
#
#   1. Token válido → estado ok, dados do payload preservados
#   2. Token adulterado (1 byte no payload) → invalid
#   3. Assinatura de OUTRA chave → invalid
#   4. Licença vencida → expired, e expired bloqueia cadastro novo
#   5. Vencendo em ≤14 dias → expiring, e expiring NÃO bloqueia
#   6. Limite de servidores: N permitido, N+1 recusado
#   7. Sem licença → missing com cortesia de 1 servidor / 30 dias
#   8. Cortesia esgotada → bloqueia cadastro novo
#   9. Nenhum estado ruim implica travar painel/coleta (só block_reason)
#
# Uso: bash tests/test_license.sh
# =============================================================================
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

GREEN='\033[0;32m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
PASS=0; FAIL=0
ok()   { echo -e "  ${GREEN}✓${NC} $*"; PASS=$((PASS+1)); }
bad()  { echo -e "  ${RED}✗${NC} $*"; FAIL=$((FAIL+1)); }

echo -e "\n${BOLD}T6 — Licença soft${NC}\n"

command -v python3 >/dev/null || { echo "python3 ausente"; exit 1; }
python3 -c "import cryptography" 2>/dev/null || { echo "lib cryptography ausente"; exit 1; }

OUT="$(python3 - <<'PY'
import base64, json, sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, "backend")
from cryptography.hazmat.primitives.asymmetric import ed25519

import app.license as lic

# Chave de teste: substitui a pública embutida para podermos assinar aqui.
signing = ed25519.Ed25519PrivateKey.generate()
lic._PUBLIC_KEY_B64 = base64.b64encode(
    signing.public_key().public_bytes_raw()
    if hasattr(signing.public_key(), "public_bytes_raw") else
    signing.public_key().public_bytes(
        encoding=__import__("cryptography.hazmat.primitives.serialization",
                            fromlist=["Encoding"]).Encoding.Raw,
        format=__import__("cryptography.hazmat.primitives.serialization",
                          fromlist=["PublicFormat"]).PublicFormat.Raw)
).decode()

intruder = ed25519.Ed25519PrivateKey.generate()

now = datetime.now(timezone.utc).replace(microsecond=0)

def make(days, servers=3, key=signing, customer="acme"):
    payload = {
        "customer": customer,
        "license_id": "lic_test",
        "issued_at": now.isoformat(),
        "expires_at": (now + timedelta(days=days)).isoformat(),
        "max_servers": servers,
        "features": [],
    }
    p = lic.canonical_payload(payload)
    return f"{p}.{lic.b64url_encode(key.sign(p.encode('ascii')))}"

r = {}

# 1. válido
s = lic.verify_token(make(365, servers=5))
r["valido_estado"] = s.state
r["valido_cliente"] = s.customer
r["valido_max"] = s.max_servers
r["valido_valid"] = s.valid

# 2. adulterado — troca um caractere do payload
tok = make(365)
p, sig = tok.split(".")
p_bad = ("A" if p[10] != "A" else "B").join([p[:10], p[11:]])
r["adulterado"] = lic.verify_token(f"{p_bad}.{sig}").state

# 3. assinatura de outra chave
r["chave_errada"] = lic.verify_token(make(365, key=intruder)).state

# 4. vencida
s = lic.verify_token(make(-5))
r["vencida"] = s.state
r["vencida_valid"] = s.valid
s.servers_used = 0
r["vencida_bloqueia"] = s.block_reason() is not None

# 5. vencendo (10 dias) — avisa mas nao bloqueia
s = lic.verify_token(make(10, servers=3))
r["vencendo"] = s.state
r["vencendo_valid"] = s.valid
s.servers_used = 1
r["vencendo_bloqueia"] = s.block_reason() is not None

# 6. limite de servidores
s = lic.verify_token(make(365, servers=3))
s.servers_used = 2
r["limite_abaixo"] = s.block_reason() is None
s.servers_used = 3
r["limite_no_teto"] = s.block_reason() is not None

# 7/8. sem licenca — cortesia
s = lic.verify_token("")
r["ausente"] = s.state
r["ausente_max"] = s.max_servers
# cortesia em dia
s.expires_at = now + timedelta(days=20); s.servers_used = 0
r["cortesia_permite"] = s.block_reason() is None
s.servers_used = 1
r["cortesia_teto"] = s.block_reason() is not None
# cortesia esgotada
s.expires_at = now - timedelta(days=1); s.servers_used = 0
r["cortesia_expirada_bloqueia"] = s.block_reason() is not None

# 9. o dict da API nao carrega nenhuma nocao de "travar painel"
d = lic.verify_token(make(-5)).to_dict()
r["api_campos"] = sorted(d.keys())
r["api_sem_lockdown"] = not any(
    k in d for k in ("readonly", "locked", "disabled", "stop_collector")
)
print(json.dumps(r))
PY
)"

RC=$?
if [[ $RC -ne 0 ]]; then
  echo -e "${RED}Falha ao executar a lógica de licença:${NC}"
  echo "$OUT"
  exit 1
fi

get() { python3 -c "import json,sys;print(json.loads(sys.argv[1])[sys.argv[2]])" "$OUT" "$1"; }

[[ "$(get valido_estado)"  == "ok"    ]] && ok "token válido → estado ok"                  || bad "token válido → $(get valido_estado)"
[[ "$(get valido_cliente)" == "acme"  ]] && ok "payload preservado (cliente, limite)"      || bad "cliente lido errado"
[[ "$(get valido_max)"     == "5"     ]] && ok "max_servers vem do token"                  || bad "max_servers = $(get valido_max)"
[[ "$(get valido_valid)"   == "True"  ]] && ok "valid=true para licença em dia"            || bad "valid deveria ser true"

[[ "$(get adulterado)"     == "invalid" ]] && ok "payload adulterado → invalid"            || bad "adulterado → $(get adulterado)"
[[ "$(get chave_errada)"   == "invalid" ]] && ok "assinado por outra chave → invalid"      || bad "chave errada → $(get chave_errada)"

[[ "$(get vencida)"          == "expired" ]] && ok "licença vencida → expired"             || bad "vencida → $(get vencida)"
[[ "$(get vencida_valid)"    == "False"   ]] && ok "vencida não é válida"                  || bad "vencida marcada como válida"
[[ "$(get vencida_bloqueia)" == "True"    ]] && ok "vencida bloqueia cadastro novo"        || bad "vencida deveria bloquear cadastro"

[[ "$(get vencendo)"          == "expiring" ]] && ok "vence em ≤14 dias → expiring"        || bad "vencendo → $(get vencendo)"
[[ "$(get vencendo_valid)"    == "True"     ]] && ok "expiring ainda é válida"             || bad "expiring deveria ser válida"
[[ "$(get vencendo_bloqueia)" == "False"    ]] && ok "expiring avisa mas NÃO bloqueia"     || bad "expiring não pode bloquear"

[[ "$(get limite_abaixo)"  == "True" ]] && ok "abaixo do limite → cadastro liberado"       || bad "deveria liberar abaixo do limite"
[[ "$(get limite_no_teto)" == "True" ]] && ok "no teto (N de N) → N+1 recusado"            || bad "N+1 deveria ser recusado"

[[ "$(get ausente)"     == "missing" ]] && ok "sem MAILIQ_LICENSE → missing"               || bad "ausente → $(get ausente)"
[[ "$(get ausente_max)" == "1"       ]] && ok "cortesia cobre 1 servidor"                  || bad "cortesia = $(get ausente_max) servidores"
[[ "$(get cortesia_permite)" == "True" ]] && ok "cortesia em dia permite o 1º servidor"    || bad "cortesia deveria permitir o 1º"
[[ "$(get cortesia_teto)"    == "True" ]] && ok "cortesia recusa o 2º servidor"            || bad "cortesia deveria recusar o 2º"
[[ "$(get cortesia_expirada_bloqueia)" == "True" ]] && ok "cortesia esgotada bloqueia cadastro" || bad "cortesia esgotada deveria bloquear"

[[ "$(get api_sem_lockdown)" == "True" ]] && ok "resposta da API não tem nenhum campo de lockdown" || bad "API expõe campo de lockdown"

echo ""
if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}  $PASS/$PASS asserções passaram.${NC}\n"
  exit 0
fi
echo -e "${RED}${BOLD}  $FAIL de $((PASS+FAIL)) asserções falharam.${NC}\n"
exit 1
