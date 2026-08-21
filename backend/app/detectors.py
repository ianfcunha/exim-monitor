"""
Sessão 2, Tarefa 2 — os 3 detectores de incidente crítico + 1 de atenção.
Exatamente 4 tipos, nenhum a mais:

  auth_abuse    (crítico)  — conta SMTP comprometida
  reputation    (crítico)  — reputação de entrega em risco
  queue_stuck   (crítico)  — fila travada
  dest_deferral (atenção)  — rate limit de destino (ex.: 421-4.7.28 do
                              Gmail) — sempre atenção, nunca crítico: é
                              transitório e o host convive com ele.

Cada função `detect_*` é pura: recebe os dados já coletados (JSON do
diag-exim.sh --json, e para reputation também o JSON de
check-deliverability), a config de thresholds do servidor (ver
DEFAULT_THRESHOLDS/DetectorConfig em database.py) e um `baseline_fn`
(fechamento fornecido pelo chamador — ver baseline.py, Tarefa 3) —
não sabe nada de banco, SSH ou notificação. Quem orquestra chamada +
máquina de estados + notificação é incident_engine.py (Tarefa 5).

Cada detector retorna uma lista de `Candidate` (dict): um candidato por
entidade distinta que estourou o threshold neste ciclo. `entity` e
`fingerprint` (montado pelo chamador como f"{type}:{server_id}:{entity}")
são a chave de deduplicação — a mesma causa persistindo entre ciclos
deve produzir o MESMO `entity`, não um novo a cada chamada.
"""
from typing import Any, Callable, Dict, List, Optional, TypedDict

# ── Thresholds padrão por tipo — "threshold padrão, threshold configurável"
# (Tarefa 2). Sobrescritos por servidor via DetectorConfig (ver database.py
# e routers/incidents.py — formulário simples, não uma aba "Regras").
DEFAULT_THRESHOLDS: Dict[str, Dict[str, Any]] = {
    "auth_abuse": {
        # N de IPs distintos autenticando com a mesma credencial na
        # amostra de log atual (~HOURS_WINDOW horas) — sinal mais
        # específico que só volume (uma conta legítima também manda
        # volume alto).
        "distinct_ips_threshold": 3,
        # Volume X× acima da média histórica da PRÓPRIA conta na mesma
        # hora do dia (ver baseline.py) — só aplicado se houver amostra
        # de baseline suficiente, para não gerar falso positivo na
        # primeira semana (ver Tarefa 3).
        "volume_multiplier": 3.0,
        "min_baseline_samples": 5,
        # Nunca dispara por volume abaixo disto, mesmo que a conta não
        # tenha baseline nenhuma — evita "2 e-mails contra baseline 0"
        # virar incidente.
        "min_count_for_volume_check": 10,
    },
    "reputation": {
        # Cert TLS com menos que isto de validade restante já conta como
        # risco — mesmo threshold sugerido usado em _compute_trust_score
        # (routers/actions.py), sem acoplamento automático (script não
        # expõe o threshold usado lá no JSON).
        "cert_days_warn": 15,
        # SPF/DKIM/DMARC ausente só vira incidente se o domínio de fato
        # envia volume — um domínio parado não quebra entrega de
        # ninguém hoje.
        "min_volume_for_dns_check": 20,
    },
    "queue_stuck": {
        # N ciclos full consecutivos com a fila acima do baseline (ou do
        # piso, se não houver baseline) para considerar "travada" — um
        # pico isolado de 1 ciclo não é incidente.
        "consecutive_cycles": 3,
        "growth_multiplier": 2.0,
        # Piso absoluto usado quando não há baseline suficiente ainda.
        "min_queue_floor": 50,
        "frozen_consecutive_cycles": 3,
        "frozen_growth_multiplier": 2.0,
        "frozen_min_floor": 20,
    },
    "dest_deferral": {
        "min_count": 10,
        # Fração do total de deferimentos concentrada num único domínio
        # de destino — sinal de rate-limit do lado de lá, não fila
        # travada do nosso lado.
        "min_share": 0.4,
    },
}


class Candidate(TypedDict):
    type: str
    entity: str
    severity: str  # "critico" | "atencao"
    metrics: Dict[str, Any]
    suggested_fix: Dict[str, Any]  # {"description": str, "action": {"action":..,"param":..} | None}
    triggered_by: Dict[str, Any]  # {"rule": str, "threshold": .., "observed": ..}
    evidence_hint: Dict[str, Any]  # dados p/ incident_engine buscar evidência real (linhas de log)


# baseline_fn(entity: str, metric: str) -> Optional[{"mean": float, "stddev": float, "samples": int}]
BaselineFn = Callable[[str, str], Optional[Dict[str, float]]]


def _cfg(config: Optional[Dict[str, Any]], detector_type: str) -> Dict[str, Any]:
    merged = dict(DEFAULT_THRESHOLDS[detector_type])
    if config:
        merged.update({k: v for k, v in config.items() if k in merged})
    return merged


# ============================================================
# 1. auth_abuse — conta SMTP comprometida
# ============================================================
def detect_auth_abuse(data: Dict[str, Any], config: Optional[Dict[str, Any]],
                      baseline_fn: BaselineFn) -> List[Candidate]:
    th = _cfg(config, "auth_abuse")
    out: List[Candidate] = []

    for entry in data.get("auth_ip_diversity") or []:
        user = entry.get("user")
        if not user:
            continue
        distinct_ips = int(entry.get("distinct_ips") or 0)
        count = int(entry.get("count") or 0)

        reasons = []
        if distinct_ips >= th["distinct_ips_threshold"]:
            reasons.append(("distinct_ips", distinct_ips, th["distinct_ips_threshold"]))

        if count >= th["min_count_for_volume_check"]:
            bl = baseline_fn(user, "auth_volume")
            if bl and bl.get("samples", 0) >= th["min_baseline_samples"] and bl.get("mean", 0) > 0:
                mult = count / bl["mean"]
                if mult >= th["volume_multiplier"]:
                    reasons.append(("volume_multiplier", round(mult, 2), th["volume_multiplier"]))

        if not reasons:
            continue

        rule, observed, threshold = reasons[0]
        out.append(Candidate(
            type="auth_abuse",
            entity=user,
            severity="critico",
            metrics={
                "distinct_ips": distinct_ips,
                "auth_count": count,
                "reasons": [{"rule": r, "observed": o, "threshold": t} for r, o, t in reasons],
            },
            suggested_fix={
                "description": (
                    f"A conta {user} autenticou de {distinct_ips} IPs diferentes "
                    f"({count} envios na janela analisada) — padrão típico de credencial "
                    f"vazada usada para relay de spam. Ação recomendada: colocar em "
                    f"quarentena as mensagens já na fila desta conta (efeito esperado: "
                    f"para o relay em andamento sem apagar nada — dá pra restaurar depois "
                    f"se for engano) e trocar a senha da conta manualmente — isso o painel "
                    f"não faz sozinho."
                ),
                "action": {"action": "clean-auth", "param": user},
            },
            triggered_by={"rule": f"auth_abuse.{rule}", "threshold": threshold, "observed": observed},
            evidence_hint={"log_filter": "sent", "match": user},
        ))

    return out


# ============================================================
# 2. reputation — reputação de entrega em risco
# ============================================================
def detect_reputation(deliverability: Optional[Dict[str, Any]], data: Dict[str, Any],
                      config: Optional[Dict[str, Any]]) -> List[Candidate]:
    if not deliverability:
        return []

    th = _cfg(config, "reputation")
    out: List[Candidate] = []
    domain = deliverability.get("domain") or ""
    ip = deliverability.get("ip") or ""
    top_sender_count = int(data.get("top_sender_count") or 0)

    # ── Blocklist (DNSBL) ──────────────────────────────────────────
    # diag-exim.sh (check_blacklists_json) usa a chave "list" pro nome
    # da DNSBL, não "blocklist" — confirmado ao vivo contra o JSON real
    # (bateu "?" na descrição antes desta correção).
    blocklists = deliverability.get("blocklists") or []
    listed = [b for b in blocklists if b.get("listed")]
    if listed and ip:
        names = ", ".join(b.get("list", "?") for b in listed)
        out.append(Candidate(
            type="reputation",
            entity=f"ip:{ip}",
            severity="critico",
            metrics={"blocklists_listed": [b.get("list") for b in listed], "ip": ip},
            suggested_fix={
                "description": (
                    f"O IP de saída {ip} está listado em {len(listed)} blocklist(s) "
                    f"({names}) — provedores como Gmail/Outlook começam a rejeitar ou "
                    f"jogar em spam a partir daqui. Não há correção de um clique: é "
                    f"preciso identificar e parar a origem do spam (ver incidentes "
                    f"auth_abuse/queue_stuck relacionados) e depois solicitar remoção "
                    f"manualmente no site de cada blocklist listada."
                ),
                "action": None,
            },
            triggered_by={"rule": "reputation.blocklist", "threshold": 1, "observed": len(listed)},
            evidence_hint={"deliverability_component": "blocklists"},
        ))

    # ── SPF/DKIM/DMARC ausente (só importa se o domínio envia volume) ──
    if domain and top_sender_count >= th["min_volume_for_dns_check"]:
        missing = []
        for key, label in (("spf", "SPF"), ("dkim", "DKIM"), ("dmarc", "DMARC")):
            comp = deliverability.get(key) or {}
            if not comp.get("found"):
                missing.append(label)
        if missing:
            out.append(Candidate(
                type="reputation",
                entity=f"domain:{domain}",
                severity="critico",
                metrics={"missing": missing, "domain": domain, "recent_volume": top_sender_count},
                suggested_fix={
                    "description": (
                        f"O domínio {domain} envia volume real ({top_sender_count} "
                        f"mensagens recentes) mas está sem {', '.join(missing)} — sem "
                        f"essas verificações, provedores grandes derrubam a taxa de "
                        f"entrega ou jogam em spam. Requer alterar registros DNS do "
                        f"domínio (fora do alcance deste painel — precisa acesso ao "
                        f"provedor de DNS)."
                    ),
                    "action": None,
                },
                triggered_by={"rule": "reputation.dns_auth_missing", "threshold": 0, "observed": len(missing)},
                evidence_hint={"deliverability_component": "spf_dkim_dmarc"},
            ))

    # ── Certificado TLS expirando ────────────────────────────────────
    cert = deliverability.get("cert") or {}
    days_remaining = cert.get("days_remaining")
    if cert and (not cert.get("valid") or (days_remaining is not None and days_remaining <= th["cert_days_warn"])):
        out.append(Candidate(
            type="reputation",
            entity=f"domain:{domain or ip or 'cert'}",
            severity="critico",
            metrics={"cert_valid": cert.get("valid"), "days_remaining": days_remaining},
            suggested_fix={
                "description": (
                    "Certificado TLS inválido ou expirando em breve — sem STARTTLS "
                    "válido, entregas via TLS obrigatório passam a falhar. Renovar o "
                    "certificado (ex.: certbot renew) — fora do alcance deste painel."
                ) if not cert.get("valid") else (
                    f"Certificado TLS expirado há {abs(days_remaining)} dia(s) — entregas "
                    f"com TLS obrigatório já devem estar falhando. Renovar o certificado."
                ) if days_remaining is not None and days_remaining < 0 else (
                    f"Certificado TLS expira em {days_remaining} dia(s) — renovar antes "
                    f"que expire para não quebrar entregas com TLS obrigatório."
                ),
                "action": None,
            },
            triggered_by={"rule": "reputation.cert_expiring", "threshold": th["cert_days_warn"], "observed": days_remaining},
            evidence_hint={"deliverability_component": "cert"},
        ))

    return out


# ============================================================
# 3. queue_stuck — fila travada
# ============================================================
def detect_queue_stuck(recent_full_snapshots: List[Dict[str, Any]], data: Dict[str, Any],
                       config: Optional[Dict[str, Any]], baseline_fn: BaselineFn) -> List[Candidate]:
    """
    `recent_full_snapshots` = últimos N Snapshot.data (mode="full"),
    mais recente primeiro, já incluindo o ciclo atual — quem chama
    (incident_engine.py) monta essa lista a partir do histórico
    persistido, não este módulo.
    """
    th = _cfg(config, "queue_stuck")
    out: List[Candidate] = []

    def _queue_totals(key: str) -> List[int]:
        vals = []
        for snap in recent_full_snapshots[: max(th["consecutive_cycles"], th["frozen_consecutive_cycles"])]:
            q = (snap or {}).get("queue") or {}
            vals.append(int(q.get(key) or 0))
        return vals

    # ── Fila geral ────────────────────────────────────────────────
    totals = _queue_totals("total")
    n = th["consecutive_cycles"]
    if len(totals) >= n:
        window = totals[:n]
        bl = baseline_fn("", "queue_total")
        floor = th["min_queue_floor"]
        if bl and bl.get("samples", 0) >= 5 and bl.get("mean", 0) > 0:
            floor = max(floor, bl["mean"] * th["growth_multiplier"])
        # não-decrescente (travada = não está esvaziando) e toda acima do piso
        growing = all(window[i] >= window[i + 1] for i in range(len(window) - 1))
        above_floor = all(v >= floor for v in window)
        if growing and above_floor:
            top_sender = data.get("top_sender") or ""
            top_sender_count = int(data.get("top_sender_count") or 0)
            top_dest = data.get("top_dest_domain") or ""
            top_dest_count = int(data.get("top_dest_domain_count") or 0)

            queue_total = window[0]
            if top_sender and top_sender_count >= top_dest_count and top_sender_count > 0:
                entity, cause = f"sender:{top_sender}", "remetente"
                action = {"action": "clean-sender", "param": top_sender}
            elif top_dest:
                entity, cause = f"domain:{top_dest}", "destino"
                action = {"action": "retry-queue", "param": None}
            else:
                entity, cause = "geral", "indeterminada"
                action = {"action": "retry-queue", "param": None}

            out.append(Candidate(
                type="queue_stuck",
                entity=entity,
                severity="critico",
                metrics={"queue_total": queue_total, "window": window, "baseline_floor": round(floor, 1),
                         "cause": cause, "top_sender": top_sender, "top_dest_domain": top_dest},
                suggested_fix={
                    "description": (
                        f"A fila está em {queue_total} mensagens e não esvazia há "
                        f"{n} ciclos consecutivos ({window}), "
                        + (f"concentrada no remetente {top_sender} ({top_sender_count} msgs) — "
                           f"limpar esse remetente deve esvaziar a maior parte da fila."
                           if cause == "remetente" else
                           f"concentrada em mensagens para {top_dest} ({top_dest_count} msgs) — "
                           f"provavelmente o destino está recusando/atrasando; forçar "
                           f"reprocessamento não resolve a causa, só reduz a fila atual."
                           if cause == "destino" else
                           "sem remetente ou destino dominante identificado.")
                    ),
                    "action": action,
                },
                triggered_by={"rule": "queue_stuck.consecutive_growth", "threshold": round(floor, 1), "observed": queue_total},
                evidence_hint={"log_filter": "deferred" if cause == "destino" else "sent",
                               "match": top_dest if cause == "destino" else top_sender},
            ))

    # ── Frozen ────────────────────────────────────────────────────
    frozen = _queue_totals("frozen")
    nf = th["frozen_consecutive_cycles"]
    if len(frozen) >= nf:
        window = frozen[:nf]
        floor = th["frozen_min_floor"]
        growing = all(window[i] >= window[i + 1] for i in range(len(window) - 1))
        above_floor = all(v >= floor for v in window)
        if growing and above_floor:
            out.append(Candidate(
                type="queue_stuck",
                entity="frozen",
                severity="critico",
                metrics={"frozen_count": window[0], "window": window, "floor": floor},
                suggested_fix={
                    "description": (
                        f"{window[0]} mensagens frozen há {nf} ciclos consecutivos "
                        f"({window}) — não vão ser reentregues sozinhas. Remover as "
                        f"frozen (quarentenadas antes, com opção de restaurar)."
                    ),
                    "action": {"action": "clean-frozen", "param": None},
                },
                triggered_by={"rule": "queue_stuck.frozen_growth", "threshold": floor, "observed": window[0]},
                evidence_hint={"log_filter": "deferred", "match": ""},
            ))

    return out


# ============================================================
# 4. dest_deferral — rate limit de destino (sempre atenção)
# ============================================================
def detect_dest_deferral(data: Dict[str, Any], config: Optional[Dict[str, Any]]) -> List[Candidate]:
    th = _cfg(config, "dest_deferral")
    out: List[Candidate] = []

    domains = data.get("top_defer_domains") or []
    if not domains:
        return out

    total_deferred = sum(int(d.get("count") or 0) for d in domains)
    if total_deferred <= 0:
        return out

    top = max(domains, key=lambda d: int(d.get("count") or 0))
    count = int(top.get("count") or 0)
    domain = top.get("domain") or ""
    share = count / total_deferred if total_deferred else 0

    if not domain or count < th["min_count"] or share < th["min_share"]:
        return out

    out.append(Candidate(
        type="dest_deferral",
        entity=f"domain:{domain}",
        severity="atencao",
        metrics={"deferred_count": count, "share_of_total": round(share, 2), "total_deferred": total_deferred},
        suggested_fix={
            "description": (
                f"{domain} está adiando {count} de {total_deferred} entregas "
                f"({int(share * 100)}%) — típico de rate-limit do lado do destino "
                f"(ex.: 421-4.7.28 do Gmail), não um problema deste servidor. "
                f"É transitório: o Exim já reencaminha sozinho nas próximas "
                f"tentativas — nenhuma ação é necessária."
            ),
            "action": None,
        },
        triggered_by={"rule": "dest_deferral.share_of_total", "threshold": th["min_share"], "observed": round(share, 2)},
        evidence_hint={"log_filter": "deferred", "match": domain},
    ))

    return out
