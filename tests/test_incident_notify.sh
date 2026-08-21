#!/usr/bin/env bash
# ============================================================
# Teste de aceite — Sessão 2, Tarefa 4 (notificação de incidentes).
#
# Critério de aceite explícito da tarefa: um incidente simulado que
# abre, agrava e resolve gera EXATAMENTE 3 mensagens por canal — não
# uma por ciclo de detecção. Também prova as 3 formas de silenciamento
# (por tipo, por incidente, janela noturna só p/ severidade atenção —
# crítico ignora a janela).
#
# Roda dentro do container backend (precisa do SQLAlchemy + banco real)
# — recebe o webhook num http.server efêmero DENTRO do mesmo processo
# (127.0.0.1), evitando problemas de rede entre containers.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

docker compose -f "$SCRIPT_DIR/docker-compose.yml" exec -T backend sh -c "PYTHONPATH=/app python3" <<'PYEOF'
import threading, http.server, json, time
from datetime import datetime, timedelta

received = []

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        received.append(json.loads(self.rfile.read(length)))
        self.send_response(200)
        self.end_headers()
    def log_message(self, *a): pass

httpd = http.server.HTTPServer(("127.0.0.1", 18765), Handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()

from app.database import SessionLocal, Server, Incident, AlertHistory, get_alert_settings, record_incident_event
from app.incident_notify import notify_incident_event

fails = []
def check(cond, label):
    (print(f"  OK   - {label}") if cond else (fails.append(label), print(f"  FAIL - {label}")))

db = SessionLocal()
server = db.query(Server).first()
assert server, "precisa de pelo menos 1 servidor cadastrado"
sid = server.id

cfg = get_alert_settings(db, server_id=sid)
saved = {c: getattr(cfg, c) for c in (
    "webhook_url", "webhook_secret", "email_enabled", "telegram_enabled",
    "incident_notify_critical", "incident_notify_atencao", "muted_incident_types",
    "night_silence_start", "night_silence_end",
)}
cfg.webhook_url = "http://127.0.0.1:18765/hook"
cfg.webhook_secret = ""
cfg.email_enabled = False
cfg.telegram_enabled = False
cfg.incident_notify_critical = True
cfg.incident_notify_atencao = True
cfg.muted_incident_types = []
cfg.night_silence_start = ""
cfg.night_silence_end = ""
db.commit()

inc = Incident(
    server_id=sid, type="auth_abuse", severity="critico", status="aberto",
    fingerprint=f"auth_abuse:{sid}:__test_notify__", entity="__test_notify__",
    metrics={}, suggested_fix={"description": "teste"}, triggered_by={},
)
db.add(inc); db.commit(); db.refresh(inc)

for event, mutate in (
    ("opened", lambda: None),
    ("escalated", lambda: setattr(inc, "last_seen", datetime.utcnow())),
    ("resolved", lambda: (setattr(inc, "status", "resolvido"), setattr(inc, "resolution", "manual"))),
):
    mutate()
    record_incident_event(db, inc, event, actor="system")
    db.commit()
    notify_incident_event(inc, event)

time.sleep(0.3)
check(len(received) == 3, f"abre+agrava+resolve gera exatamente 3 mensagens (recebeu {len(received)})")
check([r["event"] for r in received] == ["opened", "escalated", "resolved"], "ordem dos eventos é opened, escalated, resolved")

received.clear()
cfg.muted_incident_types = ["auth_abuse"]; db.commit()
notify_incident_event(inc, "opened")
time.sleep(0.2)
check(len(received) == 0, "tipo silenciado (muted_incident_types) não notifica")
cfg.muted_incident_types = []; db.commit()

received.clear()
inc.silenced_until = datetime.utcnow() + timedelta(hours=1); db.commit()
notify_incident_event(inc, "opened")
time.sleep(0.2)
check(len(received) == 0, "incidente silenciado individualmente não notifica")
inc.silenced_until = None; db.commit()

received.clear()
now = datetime.utcnow()
cfg.night_silence_start = (now - timedelta(minutes=1)).strftime("%H:%M")
cfg.night_silence_end   = (now + timedelta(minutes=1)).strftime("%H:%M")
db.commit()
inc.severity = "atencao"; db.commit()
notify_incident_event(inc, "opened")
time.sleep(0.2)
check(len(received) == 0, "janela de silêncio noturno silencia severidade atenção")

received.clear()
inc.severity = "critico"; db.commit()
notify_incident_event(inc, "opened")
time.sleep(0.2)
check(len(received) == 1, "severidade crítica ignora a janela de silêncio noturno")

# restaura config original e limpa dados de teste
for k, v in saved.items():
    setattr(cfg, k, v)
db.commit()
db.query(AlertHistory).filter(AlertHistory.server_id == sid, AlertHistory.problem.like("%__test_notify__%")).delete(synchronize_session=False)
db.delete(inc)
db.commit()
db.close()
httpd.shutdown()

print()
if fails:
    print(f"FALHOU: {len(fails)} asserção(ões)")
    raise SystemExit(1)
print("TODOS OS TESTES DE NOTIFICAÇÃO DE INCIDENTES PASSARAM")
PYEOF
