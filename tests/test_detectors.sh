#!/usr/bin/env bash
# ============================================================
# Teste de aceite — Sessão 2, Tarefa 2 (detectores de incidente).
#
# Prova, com dados sintéticos, que os 4 detectores (auth_abuse,
# reputation, queue_stuck, dest_deferral) disparam exatamente quando
# o threshold é cruzado e NÃO disparam abaixo dele — inclusive o caso
# mais fácil de acertar por acidente: queue_stuck exige crescimento
# CONSECUTIVO (um ciclo que cai no meio da janela não deve contar).
#
# detectors.py é puro (só stdlib `typing`, sem SQLAlchemy/SSH) —
# roda com o python3 do host, sem precisar do container.
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PYTHONPATH="$SCRIPT_DIR/backend" python3 - <<'EOF'
from app.detectors import detect_auth_abuse, detect_reputation, detect_queue_stuck, detect_dest_deferral

fails = []
def check(cond, label):
    (print(f"  OK   - {label}") if cond else (fails.append(label), print(f"  FAIL - {label}")))

def bl_none(entity, metric): return None
def bl_mean10(entity, metric): return {"mean": 10.0, "stddev": 2.0, "samples": 10}

# ── auth_abuse ──────────────────────────────────────────────
c = detect_auth_abuse({"auth_ip_diversity": [
    {"user": "login:victim@dominio.com", "distinct_ips": 4, "count": 42},
    {"user": "login:normal@dominio.com", "distinct_ips": 1, "count": 5},
]}, None, bl_none)
check(len(c) == 1 and c[0]["entity"] == "login:victim@dominio.com", "auth_abuse dispara só para IP diverso acima do threshold")

c = detect_auth_abuse({"auth_ip_diversity": [{"user": "login:bulk@dominio.com", "distinct_ips": 1, "count": 100}]}, None, bl_mean10)
check(len(c) == 1 and c[0]["triggered_by"]["rule"] == "auth_abuse.volume_multiplier", "auth_abuse dispara por volume 10x baseline mesmo com 1 IP só")

c = detect_auth_abuse({"auth_ip_diversity": [{"user": "a@b.com", "distinct_ips": 2, "count": 5}]}, None, bl_none)
check(c == [], "auth_abuse NÃO dispara abaixo do threshold (2 IPs, volume baixo, sem baseline)")

# ── reputation ──────────────────────────────────────────────
deliv_listed = {"ip": "1.2.3.4", "domain": "d.com", "blocklists": [{"blocklist": "zen.spamhaus.org", "listed": True}],
                "spf": {"found": True}, "dkim": {"found": True}, "dmarc": {"found": True}, "cert": {"valid": True, "days_remaining": 90}}
c = detect_reputation(deliv_listed, {"top_sender_count": 5}, None)
check(len(c) == 1 and c[0]["entity"] == "ip:1.2.3.4", "reputation dispara para IP listado em blocklist")

deliv_clean = {"ip": "1.2.3.4", "domain": "d.com", "blocklists": [{"blocklist": "x", "listed": False}],
               "spf": {"found": True}, "dkim": {"found": True}, "dmarc": {"found": True}, "cert": {"valid": True, "days_remaining": 90}}
check(detect_reputation(deliv_clean, {"top_sender_count": 5}, None) == [], "reputation NÃO dispara quando tudo limpo")

deliv_nospf_lowvol = dict(deliv_clean, spf={"found": False})
check(detect_reputation(deliv_nospf_lowvol, {"top_sender_count": 3}, None) == [], "reputation NÃO dispara SPF ausente em domínio de baixo volume")
deliv_nospf_hivol = dict(deliv_clean, spf={"found": False})
c = detect_reputation(deliv_nospf_hivol, {"top_sender_count": 50}, None)
check(len(c) == 1 and "SPF" in c[0]["metrics"]["missing"], "reputation dispara SPF ausente quando domínio envia volume")

# ── queue_stuck ─────────────────────────────────────────────
snaps_growing = [{"queue": {"total": 300, "frozen": 5}}, {"queue": {"total": 250, "frozen": 5}}, {"queue": {"total": 200, "frozen": 5}}]
data_sender = {"top_sender": "spammer@x.com", "top_sender_count": 150, "top_dest_domain": "", "top_dest_domain_count": 0}
c = detect_queue_stuck(snaps_growing, data_sender, None, bl_none)
check(len(c) == 1 and c[0]["entity"] == "sender:spammer@x.com", "queue_stuck atribui causa ao remetente dominante")

snaps_dip = [{"queue": {"total": 300, "frozen": 0}}, {"queue": {"total": 250, "frozen": 0}}, {"queue": {"total": 260, "frozen": 0}}]
check(detect_queue_stuck(snaps_dip, data_sender, None, bl_none) == [], "queue_stuck NÃO dispara se um ciclo no meio cair (não é consecutivo)")

snaps_small = [{"queue": {"total": 10, "frozen": 0}}] * 3
check(detect_queue_stuck(snaps_small, {"top_sender": "", "top_sender_count": 0, "top_dest_domain": "", "top_dest_domain_count": 0}, None, bl_none) == [],
      "queue_stuck NÃO dispara abaixo do piso mínimo")

snaps_frozen = [{"queue": {"total": 5, "frozen": 30}}, {"queue": {"total": 5, "frozen": 25}}, {"queue": {"total": 5, "frozen": 21}}]
c = detect_queue_stuck(snaps_frozen, {"top_sender": "", "top_sender_count": 0, "top_dest_domain": "", "top_dest_domain_count": 0}, None, bl_none)
check(len(c) == 1 and c[0]["entity"] == "frozen", "queue_stuck detecta frozen crescendo separado da fila geral")

# ── dest_deferral ───────────────────────────────────────────
c = detect_dest_deferral({"top_defer_domains": [{"domain": "gmail.com", "count": 40}, {"domain": "other.com", "count": 5}]}, None)
check(len(c) == 1 and c[0]["severity"] == "atencao", "dest_deferral dispara com severidade atenção (nunca crítico)")

check(detect_dest_deferral({"top_defer_domains": [{"domain": "gmail.com", "count": 2}]}, None) == [],
      "dest_deferral NÃO dispara abaixo do count mínimo")

print()
if fails:
    print(f"FALHOU: {len(fails)} asserção(ões)")
    raise SystemExit(1)
print("TODOS OS TESTES DE DETECTORES PASSARAM")
EOF
