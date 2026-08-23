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

# Sessão 4, T1: todo detector devolve (candidatos, checagens). Estes
# wrappers mantêm as asserções abaixo focadas nos candidatos; as
# checagens têm asserções próprias no fim do arquivo.
def cands(result): return result[0]
def checks(result): return {c["key"]: c for c in result[1]}

fails = []
def check(cond, label):
    (print(f"  OK   - {label}") if cond else (fails.append(label), print(f"  FAIL - {label}")))

def bl_none(entity, metric): return None
def bl_mean10(entity, metric): return {"mean": 10.0, "stddev": 2.0, "samples": 10}

# ── auth_abuse ──────────────────────────────────────────────
c = cands(detect_auth_abuse({"auth_ip_diversity": [
    {"user": "login:victim@dominio.com", "distinct_ips": 4, "count": 42},
    {"user": "login:normal@dominio.com", "distinct_ips": 1, "count": 5},
]}, None, bl_none))
check(len(c) == 1 and c[0]["entity"] == "login:victim@dominio.com", "auth_abuse dispara só para IP diverso acima do threshold")

c = cands(detect_auth_abuse({"auth_ip_diversity": [{"user": "login:bulk@dominio.com", "distinct_ips": 1, "count": 100}]}, None, bl_mean10))
check(len(c) == 1 and c[0]["triggered_by"]["rule"] == "auth_abuse.volume_multiplier", "auth_abuse dispara por volume 10x baseline mesmo com 1 IP só")

c = cands(detect_auth_abuse({"auth_ip_diversity": [{"user": "a@b.com", "distinct_ips": 2, "count": 5}]}, None, bl_none))
check(c == [], "auth_abuse NÃO dispara abaixo do threshold (2 IPs, volume baixo, sem baseline)")

# ── reputation ──────────────────────────────────────────────
deliv_listed = {"ip": "1.2.3.4", "domain": "d.com", "blocklists": [{"list": "zen.spamhaus.org", "status": "listado", "listed": True}],
                "spf": {"found": True}, "dkim": {"found": True}, "dmarc": {"found": True}, "cert": {"status": "ok", "parsed": True, "expired": False, "days_remaining": 90, "hostname": "mail.d.com"}}
c = cands(detect_reputation(deliv_listed, {"top_sender_count": 5}, None))
check(len(c) == 1 and c[0]["entity"] == "ip:1.2.3.4", "reputation dispara para IP listado em blocklist")

deliv_clean = {"ip": "1.2.3.4", "domain": "d.com", "blocklists": [{"list": "x", "status": "limpo", "listed": False}],
               "spf": {"found": True}, "dkim": {"found": True}, "dmarc": {"found": True}, "cert": {"status": "ok", "parsed": True, "expired": False, "days_remaining": 90, "hostname": "mail.d.com"}}
check(cands(detect_reputation(deliv_clean, {"top_sender_count": 5}, None)) == [], "reputation NÃO dispara quando tudo limpo")

deliv_nospf_lowvol = dict(deliv_clean, spf={"found": False})
check(cands(detect_reputation(deliv_nospf_lowvol, {"top_sender_count": 3}, None)) == [], "reputation NÃO dispara SPF ausente em domínio de baixo volume")
deliv_nospf_hivol = dict(deliv_clean, spf={"found": False})
c = cands(detect_reputation(deliv_nospf_hivol, {"top_sender_count": 50}, None))
check(len(c) == 1 and "SPF" in c[0]["metrics"]["missing"], "reputation dispara SPF ausente quando domínio envia volume")

# ── queue_stuck ─────────────────────────────────────────────
snaps_growing = [{"queue": {"total": 300, "frozen": 5}}, {"queue": {"total": 250, "frozen": 5}}, {"queue": {"total": 200, "frozen": 5}}]
data_sender = {"top_sender": "spammer@x.com", "top_sender_count": 150, "top_dest_domain": "", "top_dest_domain_count": 0}
c = cands(detect_queue_stuck(snaps_growing, data_sender, None, bl_none))
check(len(c) == 1 and c[0]["entity"] == "sender:spammer@x.com", "queue_stuck atribui causa ao remetente dominante")

snaps_dip = [{"queue": {"total": 300, "frozen": 0}}, {"queue": {"total": 250, "frozen": 0}}, {"queue": {"total": 260, "frozen": 0}}]
check(cands(detect_queue_stuck(snaps_dip, data_sender, None, bl_none)) == [], "queue_stuck NÃO dispara se um ciclo no meio cair (não é consecutivo)")

snaps_small = [{"queue": {"total": 10, "frozen": 0}}] * 3
check(cands(detect_queue_stuck(snaps_small, {"top_sender": "", "top_sender_count": 0, "top_dest_domain": "", "top_dest_domain_count": 0}, None, bl_none)) == [],
      "queue_stuck NÃO dispara abaixo do piso mínimo")

snaps_frozen = [{"queue": {"total": 5, "frozen": 30}}, {"queue": {"total": 5, "frozen": 25}}, {"queue": {"total": 5, "frozen": 21}}]
c = cands(detect_queue_stuck(snaps_frozen, {"top_sender": "", "top_sender_count": 0, "top_dest_domain": "", "top_dest_domain_count": 0}, None, bl_none))
check(len(c) == 1 and c[0]["entity"] == "frozen", "queue_stuck detecta frozen crescendo separado da fila geral")

# ── dest_deferral ───────────────────────────────────────────
c = cands(detect_dest_deferral({"top_defer_domains": [{"domain": "gmail.com", "count": 40}, {"domain": "other.com", "count": 5}]}, None))
check(len(c) == 1 and c[0]["severity"] == "atencao", "dest_deferral dispara com severidade atenção (nunca crítico)")

check(cands(detect_dest_deferral({"top_defer_domains": [{"domain": "gmail.com", "count": 2}]}, None)) == [],
      "dest_deferral NÃO dispara abaixo do count mínimo")

# ── Sessão 4, T1: o quarto estado ───────────────────────────
print()
print("── Sessão 4, T1: desconhecido nunca é crítico nem saudável ──")

# Aceite literal da tarefa: apontar o checador de TLS para um alvo sem
# hostname para SNI e o resultado ser "não foi possível verificar", sem
# incidente aberto. Este é o payload que o script devolve nesse caso.
cert_sem_sni = dict(deliv_clean, cert={
    "status": "desconhecido", "parsed": False,
    "reason": "sem hostname para SNI — banner SMTP, DNS reverso e MX nao forneceram um nome valido",
    "hostname": None, "hostname_source": "none", "sni_sent": False, "days_remaining": None,
})
cands_sni, checks_sni = detect_reputation(cert_sem_sni, {"top_sender_count": 5}, None)
checks_sni = {c["key"]: c for c in checks_sni}
check(not any(c["subtype"] == "cert" for c in cands_sni),
      "TLS sem hostname para SNI NÃO abre incidente")
check(checks_sni["reputation.cert"]["status"] == "desconhecido"
      and "SNI" in checks_sni["reputation.cert"]["reason"],
      "TLS sem hostname para SNI vira 'desconhecido' com o motivo (sem hostname para SNI)")

# O certificado autogerado real deste ambiente: notAfter em 01/01/1970,
# que produzia -20687 dias e virava "expirado há 56 anos" — crítico.
cert_absurdo = dict(deliv_clean, cert={
    "status": "ok", "parsed": True, "expired": True, "days_remaining": -20687,
    "hostname": "mail.d.com", "not_after_raw": "Jan  1 02:00:00 1970 GMT",
})
cands_abs, checks_abs = detect_reputation(cert_absurdo, {"top_sender_count": 5}, None)
checks_abs = {c["key"]: c for c in checks_abs}
check(not any(c["subtype"] == "cert" for c in cands_abs),
      "validade de -20687 dias NÃO abre incidente crítico")
check(checks_abs["reputation.cert"]["status"] == "desconhecido",
      "validade fora da faixa de sanidade vira 'desconhecido', não 'crítico'")

# Consulta DNSBL recusada (127.255.255.x) não é listagem nem limpeza.
deliv_recusada = dict(deliv_clean, blocklists=[{
    "list": "zen.spamhaus.org", "status": "desconhecido", "listed": None,
    "raw": "127.255.255.254", "resolver": "8.8.8.8",
    "reason": "consulta recusada pela zona (resposta na faixa 127.255.255.0/24)",
}])
cands_rec, checks_rec = detect_reputation(deliv_recusada, {"top_sender_count": 5}, None)
checks_rec = {c["key"]: c for c in checks_rec}
check(not any(c["subtype"] == "blocklist" for c in cands_rec),
      "consulta DNSBL recusada NÃO abre incidente de blocklist")
check(checks_rec["reputation.blocklist"]["status"] == "desconhecido",
      "consulta DNSBL recusada vira 'desconhecido', não 'limpo'")

# Coleta que não trouxe o dado não pode virar servidor saudável.
_, checks_sem_auth = detect_auth_abuse({}, None, bl_none)
check(checks_sem_auth[0]["status"] == "desconhecido" and checks_sem_auth[0]["reason"],
      "coleta sem diversidade de IPs vira 'desconhecido' com motivo, não 'ok'")

_, checks_sem_deliv = detect_reputation(None, {}, None)
check(checks_sem_deliv[0]["status"] == "desconhecido",
      "checagem de entregabilidade que não rodou vira 'desconhecido', não ausência de problema")

# Contradição interna proibida: nenhum caminho pode marcar a checagem
# como ok e ao mesmo tempo descrever um certificado vencido.
for label, payload in (("expirado", cert_absurdo), ("sem SNI", cert_sem_sni)):
    _, ch = detect_reputation(payload, {"top_sender_count": 5}, None)
    cc = {c["key"]: c for c in ch}["reputation.cert"]
    check(not (cc["status"] == "ok" and (cc["detail"].get("days_remaining") or 0) < 0),
          f"certificado '{label}': não coexistem status 'ok' e validade negativa")

# ── Sessão 4, T4: entidade normalizada antes do fingerprint ──
print()
print("── Sessão 4, T4: fingerprint não depende do rótulo textual ──")

from app.detectors import make_fingerprint, normalize_entity
check(normalize_entity("domain:190.102.43.248") == normalize_entity("ip:190.102.43.248") == "ip:190.102.43.248",
      "um IPv4 é sempre 'ip:', qualquer que seja o rótulo textual de origem")
check(make_fingerprint("reputation", "blocklist", 8, "domain:190.102.43.248")
      == make_fingerprint("reputation", "blocklist", 8, "ip:190.102.43.248"),
      "o mesmo endereço com rótulos diferentes produz o MESMO fingerprint")
check(make_fingerprint("reputation", "cert", 8, "ip:190.102.43.248")
      != make_fingerprint("reputation", "blocklist", 8, "ip:190.102.43.248"),
      "certificado e blocklist do mesmo endereço continuam sendo incidentes distintos")
check(normalize_entity("sender:case.file@dominio.com") == "sender:case.file@dominio.com",
      "entidade que não é IP passa intacta pela normalização")

print()
if fails:
    print(f"FALHOU: {len(fails)} asserção(ões)")
    raise SystemExit(1)
print("TODOS OS TESTES DE DETECTORES PASSARAM")
EOF
