#!/usr/bin/env bash
# =============================================================================
# T8 — Watchdog do coletor: os três modos de falha silenciosa.
#
# O defeito que isto cobre: o painel inteiro depende de uma asyncio.Task
# continuar rodando. Se ela morre ou trava, as telas seguem servindo o
# último snapshot, o selo de saúde segue verde e nenhum alerta dispara —
# porque alerta é disparado PELA coleta. A falha do monitoramento era
# indistinguível de "está tudo bem".
#
# Prova, com um coletor falso e o relógio empurrado à mão:
#
#   1. Task viva + pulso recente          → "coletando", nada é alertado
#   2. Task MORTA (exceção)               → alerta + religa; a exceção vai pro log
#   3. Task viva mas SEM PULSO (travada)  → alerta + religa
#   4. Volta ao normal                    → alerta de recuperação, uma vez só
#   5. Servidor sem coleta além do limite → alerta deadman com o tempo em minutos
#   6. Servidor volta a responder         → alerta de recuperação, uma vez só
#   7. Servidor recém-cadastrado (nunca conectou) → NÃO é "silencioso"
#   8. Servidor removido enquanto mudo    → sai do conjunto sem "voltou" falso
#   9. Cooldown do alerta operacional     → não repete dentro da janela
#  10. Alerta operacional IGNORA severity_threshold (o limiar não silencia
#      "o painel parou de enxergar")
#
# Autocontido: sem banco, sem rede, sem stack. Os envios são interceptados.
# Uso: bash tests/test_watchdog.sh
# =============================================================================
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

GREEN='\033[0;32m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
PASS=0; FAIL=0
ok()  { echo -e "  ${GREEN}✓${NC} $*"; PASS=$((PASS+1)); }
bad() { echo -e "  ${RED}✗${NC} $*"; FAIL=$((FAIL+1)); }

echo -e "\n${BOLD}T8 — Watchdog do coletor${NC}\n"

command -v python3 >/dev/null || { echo "python3 ausente"; exit 1; }

OUT="$(python3 - <<'PY' 2>&1
import asyncio, json, sys, types
from datetime import datetime, timedelta

sys.path.insert(0, "backend")

# ── Stubs. O watchdog importa alerts/database/collector de dentro das
# funções; config ele importa no topo. Plantar módulos falsos em
# sys.modules antes do import mantém o teste sem banco, sem SMTP, sem SSH
# e sem nenhuma dependência do backend além da stdlib — assim uma falha
# aqui é sempre do watchdog, nunca do ambiente.
config = types.ModuleType("app.config")
config.settings = types.SimpleNamespace(quick_interval=30, full_interval=300)
sys.modules["app.config"] = config

enviados = []

alerts = types.ModuleType("app.alerts")
async def send_operational_alert(kind, title, detail, server_id=None, resolved=False):
    enviados.append({"kind": kind, "title": title, "detail": detail,
                     "server_id": server_id, "resolved": resolved})
    return True
def clear_operational_cooldown(kind, server_id):
    enviados.append({"kind": kind, "clear": True, "server_id": server_id})
alerts.send_operational_alert = send_operational_alert
alerts.clear_operational_cooldown = clear_operational_cooldown
sys.modules["app.alerts"] = alerts

SERVIDORES = []
class _FakeServer:
    def __init__(self, id, name, last_connected_at, ssh_status="ok", ssh_error_msg=None):
        self.id, self.name = id, name
        self.last_connected_at = last_connected_at
        self.ssh_status, self.ssh_error_msg = ssh_status, ssh_error_msg
        self.is_enabled = True

class _Q:
    def filter(self, *a, **k): return self
    def all(self): return list(SERVIDORES)
class _Session:
    def query(self, *a, **k): return _Q()
    def close(self): pass

database = types.ModuleType("app.database")
database.Server = types.SimpleNamespace(is_enabled=True)
database.SessionLocal = _Session
# alerts.py importa estes nomes no topo — o stub precisa tê-los.
database.AlertHistory = object
database.AlertSettings = object
database.get_effective_alert_settings = lambda db, server_id=None: None
sys.modules["app.database"] = database

# Coletor falso: um loop que dorme para sempre, ou um que explode.
collector = types.ModuleType("app.collector")
async def background_collector():
    await asyncio.sleep(3600)
collector.background_collector = background_collector
sys.modules["app.collector"] = collector

import app.watchdog as wd

r = {}

async def main():
    agora = datetime.utcnow()

    # ── 1. saudável ────────────────────────────────────────────────────
    wd.start_collector()
    await asyncio.sleep(0)
    wd.note_cycle("quick")
    enviados.clear()
    await wd._check_collector()
    r["saudavel_alertas"] = len(enviados)
    r["saudavel_estado"] = wd.collector_health()["state"]
    r["saudavel_viva"] = wd.collector_health()["task_alive"]

    # ── 2. task morta com exceção ─────────────────────────────────────
    async def explode():
        raise RuntimeError("boom no coletor")
    collector.background_collector = explode
    await wd._restart_collector("preparando o teste")
    await asyncio.sleep(0.05)          # deixa a task morrer
    collector.background_collector = background_collector
    wd.note_cycle("quick")             # pulso recente: só a morte importa
    enviados.clear()
    reinicios_antes = wd.collector_health()["restarts"]
    await wd._check_collector()
    await asyncio.sleep(0)
    r["morta_alertas"] = [e["kind"] for e in enviados if not e.get("clear")]
    r["morta_detalhe_tem_excecao"] = any("RuntimeError" in e.get("detail", "") for e in enviados)
    r["morta_religou"] = wd.collector_health()["restarts"] > reinicios_antes
    r["morta_viva_de_novo"] = wd.collector_health()["task_alive"]

    # ── 3. viva mas travada (sem pulso) ───────────────────────────────
    wd._last_tick_at = agora - timedelta(seconds=99999)
    wd._collector_alarm = False
    enviados.clear()
    reinicios_antes = wd.collector_health()["restarts"]
    r["travado_estado"] = wd.collector_health()["state"]
    await wd._check_collector()
    await asyncio.sleep(0)
    r["travado_alertas"] = [e["kind"] for e in enviados if not e.get("clear")]
    r["travado_detalhe"] = any("ciclo" in e.get("detail", "") for e in enviados)
    r["travado_religou"] = wd.collector_health()["restarts"] > reinicios_antes

    # ── 4. volta ao normal → recuperação uma vez só ───────────────────
    wd.note_cycle("quick")
    enviados.clear()
    await wd._check_collector()
    recup = [e for e in enviados if e.get("resolved")]
    r["recuperado_alertas"] = len(recup)
    r["recuperado_limpou_cooldown"] = any(e.get("clear") for e in enviados)
    enviados.clear()
    await wd._check_collector()
    r["recuperado_nao_repete"] = len(enviados)

    await wd.stop_collector()

    # ── 5..8. servidores silenciosos ──────────────────────────────────
    limite = wd._silence_threshold()
    SERVIDORES.clear()
    SERVIDORES.append(_FakeServer(1, "srv-mudo", agora - limite - timedelta(minutes=5),
                                  "error", "Connection timed out"))
    SERVIDORES.append(_FakeServer(2, "srv-ok", agora - timedelta(seconds=30)))
    SERVIDORES.append(_FakeServer(3, "srv-novo", None))   # nunca conectou
    wd._silent_servers.clear()
    enviados.clear()
    await wd._check_silent_servers()
    mudos = [e for e in enviados if e["kind"] == "servidor_silencioso" and not e.get("clear")]
    r["mudo_alertou_ids"] = sorted({e["server_id"] for e in mudos})
    r["mudo_tem_minutos"] = any("minutos" in e.get("detail", "") for e in mudos)
    r["mudo_tem_erro_ssh"] = any("Connection timed out" in e.get("detail", "") for e in mudos)
    r["novo_nao_alerta"] = all(e["server_id"] != 3 for e in mudos)

    enviados.clear()
    await wd._check_silent_servers()
    r["mudo_nao_repete"] = len([e for e in enviados if not e.get("clear")])

    # 6. voltou a responder
    SERVIDORES[0].last_connected_at = agora
    enviados.clear()
    await wd._check_silent_servers()
    volta = [e for e in enviados if e.get("resolved")]
    r["voltou_alertas"] = len(volta)
    r["voltou_id"] = volta[0]["server_id"] if volta else None
    enviados.clear()
    await wd._check_silent_servers()
    r["voltou_nao_repete"] = len(enviados)

    # 8. removido enquanto mudo → sem "voltou" falso
    SERVIDORES[0].last_connected_at = agora - limite - timedelta(minutes=5)
    enviados.clear()
    await wd._check_silent_servers()
    SERVIDORES.pop(0)
    enviados.clear()
    await wd._check_silent_servers()
    r["removido_sem_volta_falsa"] = not any(e.get("resolved") for e in enviados)
    r["removido_saiu_do_conjunto"] = 1 not in wd._silent_servers

asyncio.run(main())

# ── 9/10. cooldown e independência do severity_threshold ──────────────
# Aqui usa o alerts.py DE VERDADE (o stub acima era só para o watchdog),
# com os envios interceptados no nível do transporte. Os stubs de config
# e database CONTINUAM no lugar — é o que permite importar alerts.py sem
# sqlalchemy instalado.
sys.modules.pop("app.alerts", None)

import app.alerts as real_alerts

envios_reais = []
real_alerts._send_raw_email = lambda cfg, subject, html: envios_reais.append(("email", subject))
real_alerts.telegram_post = lambda cfg, text: envios_reais.append(("telegram", text))
real_alerts._send_webhook_sync = lambda *a, **k: envios_reais.append(("webhook", a[2]))
real_alerts._record_history = lambda *a, **k: None

class _Cfg:
    email_enabled = True; email_to = "op@exemplo.com"
    resend_api_key = "re_x"; smtp_password = ""; smtp_from = "a@b.c"
    telegram_enabled = True; telegram_bot_token = "t"; telegram_chat_id = "c"
    webhook_url = ""; webhook_secret = ""
    # O limiar MAIS ALTO possível: se ele silenciasse alertas operacionais,
    # nada sairia daqui.
    severity_threshold = "CRITICAL"; cooldown_minutes = 30; queue_threshold = 0

class _S2:
    def get(self, *a, **k): return None
    def close(self): pass
real_alerts.SessionLocal = _S2
real_alerts.get_effective_alert_settings = lambda db, server_id=None: _Cfg()

async def ops():
    real_alerts._operational_sent_at.clear()
    envios_reais.clear()
    primeiro = await real_alerts.send_operational_alert(
        "coletor_parado", "A coleta parou", "detalhe")
    r["ops_primeiro_saiu"] = primeiro
    r["ops_canais"] = sorted({c for c, _ in envios_reais})
    envios_reais.clear()
    segundo = await real_alerts.send_operational_alert(
        "coletor_parado", "A coleta parou", "detalhe")
    r["ops_cooldown_segurou"] = (segundo is False and len(envios_reais) == 0)
    # a recuperação passa mesmo dentro do cooldown
    envios_reais.clear()
    terceiro = await real_alerts.send_operational_alert(
        "coletor_parado", "Coleta retomada", "voltou", resolved=True)
    r["ops_recuperacao_passa"] = (terceiro is True and len(envios_reais) > 0)
    # e depois da recuperação o episódio zera
    envios_reais.clear()
    quarto = await real_alerts.send_operational_alert(
        "coletor_parado", "A coleta parou", "de novo")
    r["ops_novo_episodio_alerta"] = quarto is True

asyncio.run(ops())
print("__JSON__" + json.dumps(r))
PY
)"

RC=$?
JSON="$(printf '%s\n' "$OUT" | grep '^__JSON__' | sed 's/^__JSON__//')"
if [[ $RC -ne 0 || -z "$JSON" ]]; then
  echo -e "${RED}Falha ao executar o watchdog:${NC}"
  printf '%s\n' "$OUT" | tail -30
  exit 1
fi

get() { python3 -c "import json,sys;v=json.loads(sys.argv[1])[sys.argv[2]];print(json.dumps(v) if isinstance(v,(list,dict)) else v)" "$JSON" "$1"; }

[[ "$(get saudavel_alertas)" == "0"          ]] && ok "coletor saudável não alerta nada"            || bad "alertou com o coletor saudável"
[[ "$(get saudavel_estado)"  == "coletando"  ]] && ok "estado \"coletando\" com pulso recente"       || bad "estado = $(get saudavel_estado)"
[[ "$(get saudavel_viva)"    == "True"       ]] && ok "task reportada como viva"                     || bad "task deveria estar viva"

[[ "$(get morta_alertas)" == '["coletor_parado"]' ]] && ok "task morta → alerta coletor_parado"      || bad "morta → $(get morta_alertas)"
[[ "$(get morta_detalhe_tem_excecao)" == "True"   ]] && ok "a exceção que matou a task vai no alerta" || bad "exceção não aparece no alerta"
[[ "$(get morta_religou)"      == "True"          ]] && ok "watchdog religou o coletor"              || bad "não religou"
[[ "$(get morta_viva_de_novo)" == "True"          ]] && ok "coletor vivo de novo depois do religamento" || bad "seguiu morto"

[[ "$(get travado_estado)"  == "travado"                ]] && ok "sem pulso → estado \"travado\""     || bad "estado = $(get travado_estado)"
[[ "$(get travado_alertas)" == '["coletor_parado"]'     ]] && ok "travado (vivo, sem pulso) → alerta" || bad "travado → $(get travado_alertas)"
[[ "$(get travado_detalhe)" == "True"                   ]] && ok "alerta diz há quanto tempo não há ciclo" || bad "alerta sem o tempo sem ciclo"
[[ "$(get travado_religou)" == "True"                   ]] && ok "watchdog religou o coletor travado" || bad "não religou o travado"

[[ "$(get recuperado_alertas)" == "1"    ]] && ok "coleta retomada → 1 alerta de recuperação"        || bad "recuperação → $(get recuperado_alertas) alertas"
[[ "$(get recuperado_limpou_cooldown)" == "True" ]] && ok "recuperação limpa o cooldown do episódio" || bad "cooldown não foi limpo"
[[ "$(get recuperado_nao_repete)" == "0" ]] && ok "recuperação não se repete no ciclo seguinte"      || bad "repetiu a recuperação"

[[ "$(get mudo_alertou_ids)"  == "[1]"  ]] && ok "só o servidor mudo alerta (o saudável não)"        || bad "alertou $(get mudo_alertou_ids)"
[[ "$(get mudo_tem_minutos)"  == "True" ]] && ok "alerta diz há quantos minutos ele sumiu"           || bad "alerta sem o tempo"
[[ "$(get mudo_tem_erro_ssh)" == "True" ]] && ok "alerta carrega o último erro de SSH"               || bad "alerta sem o erro de SSH"
[[ "$(get novo_nao_alerta)"   == "True" ]] && ok "servidor que nunca conectou não é \"silencioso\""  || bad "alertou servidor recém-cadastrado"
[[ "$(get mudo_nao_repete)"   == "0"    ]] && ok "servidor mudo não realerta a cada ciclo"           || bad "realertou o mesmo servidor"

[[ "$(get voltou_alertas)"    == "1"    ]] && ok "servidor voltou → 1 alerta de recuperação"         || bad "voltou → $(get voltou_alertas) alertas"
[[ "$(get voltou_id)"         == "1"    ]] && ok "recuperação identifica o servidor certo"           || bad "recuperação do servidor $(get voltou_id)"
[[ "$(get voltou_nao_repete)" == "0"    ]] && ok "recuperação de servidor não se repete"             || bad "repetiu"

[[ "$(get removido_sem_volta_falsa)"   == "True" ]] && ok "servidor removido enquanto mudo não gera \"voltou\"" || bad "gerou recuperação falsa"
[[ "$(get removido_saiu_do_conjunto)"  == "True" ]] && ok "servidor removido sai do conjunto de mudos"          || bad "ficou preso no conjunto"

[[ "$(get ops_primeiro_saiu)"       == "True" ]] && ok "alerta operacional sai com severity_threshold=CRITICAL" || bad "o limiar silenciou o alerta operacional"
[[ "$(get ops_canais)" == '["email", "telegram"]' ]] && ok "alerta operacional usa os canais configurados"      || bad "canais: $(get ops_canais)"
[[ "$(get ops_cooldown_segurou)"    == "True" ]] && ok "cooldown segura a repetição dentro da janela"           || bad "repetiu dentro do cooldown"
[[ "$(get ops_recuperacao_passa)"   == "True" ]] && ok "recuperação ignora o cooldown"                          || bad "cooldown bloqueou a recuperação"
[[ "$(get ops_novo_episodio_alerta)" == "True" ]] && ok "episódio novo depois da recuperação alerta na hora"    || bad "novo episódio ficou preso no cooldown"

echo ""
if [[ $FAIL -eq 0 ]]; then
  echo -e "${GREEN}${BOLD}  $PASS/$PASS asserções passaram.${NC}\n"
  exit 0
fi
echo -e "${RED}${BOLD}  $FAIL de $((PASS+FAIL)) asserções falharam.${NC}\n"
exit 1
