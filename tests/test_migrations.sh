#!/usr/bin/env bash
# ============================================================
# Teste de aceite — M1/T4: o runner de migrations é idempotente
# e não perde dados.
#
# Sobe um Postgres descartável e roda run_migrations() (na imagem do
# backend) em quatro cenários:
#   1. banco novo            → schema 024
#   2. segundo boot          → no-op, sem erro, dados intactos
#   3. alembic carimbado p/ trás (018) → sobe de volta pra 024 sem
#      duplicar nem apagar dados
#   4. repetir o cenário 3   → continua estável
#
# Standalone: não depende do stack de dev. Usa MAILIQ_BACKEND_IMAGE se
# definido; senão builda a imagem do backend.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

IMAGE="${MAILIQ_BACKEND_IMAGE:-mailiq-backend-migtest}"
SUF="$$-$RANDOM"
NET="migtest-net-$SUF"
PG="migtest-pg-$SUF"

cleanup() {
  docker rm -f "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  [[ "${BUILT_IMAGE:-0}" == "1" ]] && docker rmi "$IMAGE" >/dev/null 2>&1 || true
  rm -rf "$SCRIPT_DIR/backend/diag-exim"
}
trap cleanup EXIT

PASS=0; FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  OK   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "→ imagem do backend ($IMAGE) não existe — buildando..."
  rm -rf "$SCRIPT_DIR/backend/diag-exim"
  cp -r "$SCRIPT_DIR/diag-exim" "$SCRIPT_DIR/backend/diag-exim"
  docker build -q -t "$IMAGE" "$SCRIPT_DIR/backend" >/dev/null
  rm -rf "$SCRIPT_DIR/backend/diag-exim"
  BUILT_IMAGE=1
fi

docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_DB=exim_monitor -e POSTGRES_USER=exim -e POSTGRES_PASSWORD=testpw \
  postgres:16-alpine >/dev/null

for _ in $(seq 1 30); do
  docker exec "$PG" pg_isready -U exim -d exim_monitor >/dev/null 2>&1 && break
  sleep 1
done

DBURL="postgresql://exim:testpw@${PG}:5432/exim_monitor"

run_mig() {  # roda run_migrations() na imagem; stdout+stderr no arquivo dado
  docker run --rm --network "$NET" \
    -e DATABASE_URL="$DBURL" -e ENVIRONMENT=development \
    -e MAILIQ_SKIP_PREMIGRATION_DUMP=1 \
    "$IMAGE" python -c \
    "import logging; logging.basicConfig(level=logging.INFO); from app.main import run_migrations; run_migrations()" \
    >"$1" 2>&1
}
q() { docker exec -e PGPASSWORD=testpw "$PG" psql -tAX -U exim -d exim_monitor -c "$1" | tr -d '[:space:]'; }

L=/tmp/migtest.$SUF

# ── 1. banco novo ────────────────────────────────────────────
run_mig "$L.1" && ok "boot 1 (banco novo) sem erro" || { fail "boot 1 falhou"; cat "$L.1"; }
[[ "$(q "SELECT version_num FROM alembic_version")" == "024" ]] \
  && ok "schema em 024 após boot 1" || fail "schema != 024 ($(q "SELECT version_num FROM alembic_version"))"

# sentinela: uma linha que precisa sobreviver a tudo
q "INSERT INTO servers (owner_id,name,host,port,ssh_user,ssh_auth_type,ssh_secret,script_path,is_enabled,ssh_status,observation_mode,created_at,updated_at)
   SELECT id,'sentinel','h',22,'u','key','','/x',true,'unknown',false,NOW(),NOW() FROM users LIMIT 1" >/dev/null

# ── 2. segundo boot = no-op ──────────────────────────────────
run_mig "$L.2" && ok "boot 2 (idempotente) sem erro" || { fail "boot 2 falhou"; cat "$L.2"; }
grep -q "ja esta atualizado" "$L.2" && ok "boot 2 foi no-op ('já atualizado')" || fail "boot 2 não detectou 'já atualizado'"
[[ "$(q "SELECT count(*) FROM servers WHERE name='sentinel'")" == "1" ]] \
  && ok "sentinela intacta após boot 2" || fail "sentinela sumiu/duplicou após boot 2"

# ── 3. alembic carimbado pra trás → sobe de volta ────────────
q "UPDATE alembic_version SET version_num='018'" >/dev/null
run_mig "$L.3" && ok "boot 3 (018 → 024) sem erro" || { fail "boot 3 falhou"; cat "$L.3"; }
[[ "$(q "SELECT version_num FROM alembic_version")" == "024" ]] \
  && ok "voltou para 024 após boot 3" || fail "não voltou para 024"
[[ "$(q "SELECT count(*) FROM servers WHERE name='sentinel'")" == "1" ]] \
  && ok "sentinela única (sem duplicar) após 018 → 024" || fail "sentinela corrompida após 018 → 024"

# ── 4. repetir → continua estável ────────────────────────────
q "UPDATE alembic_version SET version_num='018'" >/dev/null
run_mig "$L.4" && ok "boot 4 (018 → 024 de novo) sem erro" || { fail "boot 4 falhou"; cat "$L.4"; }
[[ "$(q "SELECT count(*) FROM servers WHERE name='sentinel'")" == "1" ]] \
  && ok "sentinela ainda única após repetir" || fail "repetição corrompeu a sentinela"

echo ""
echo "── $PASS passou, $FAIL falhou ──"
[[ "$FAIL" -eq 0 ]]
