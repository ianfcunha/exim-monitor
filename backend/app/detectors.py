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

Cada detector retorna `(candidatos, checagens)`:

  candidatos — um `Candidate` por entidade distinta que estourou o
               threshold neste ciclo. `entity` e `fingerprint` (montado
               pelo chamador, ver make_fingerprint()) são a chave de
               deduplicação: a mesma causa persistindo entre ciclos deve
               produzir o MESMO `entity`, não um novo a cada chamada.

  checagens  — um `CheckOutcome` por verificação executada, INCLUSIVE as
               que passaram e as que não puderam ser feitas.

Sessão 4, Tarefa 1 — o quarto estado. Antes, uma checagem que falhava
virava `critico` ou virava `OK`; não havia como dizer "não sei". Agora
todo `CheckOutcome` é `ok` | `alerta` | `critico` | `desconhecido`, com
motivo obrigatório fora de `ok`. `desconhecido` nunca abre incidente e
nunca conta como saudável — aparece na interface como "não foi possível
verificar — [motivo]" (ver health.py, que é quem transforma checagens +
incidentes no estado do servidor).

Sanidade de valores é obrigatória e mora aqui, não em cada detector:
qualquer métrica derivada de data ou de parse externo passa por
`sane_days()`; valor implausível vira `desconhecido`, nunca `critico`.
"""
import ipaddress
from typing import Any, Callable, Dict, List, Optional, Tuple, TypedDict

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


STATUS_OK = "ok"
STATUS_ALERTA = "alerta"
STATUS_CRITICO = "critico"
STATUS_DESCONHECIDO = "desconhecido"

# Faixa de plausibilidade para qualquer contagem de dias derivada de uma
# data externa. Um certificado autogerado do Exim com notAfter em
# 01/01/1970 produz -20687 dias (~56 anos) — isso não é um certificado
# vencido, é um parse sem sentido, e tratá-lo como crítico foi o que
# gerou o INC-58.
SANE_DAYS_MIN = -3650
SANE_DAYS_MAX = 3650


def sane_days(value: Any) -> Optional[int]:
    """Devolve o valor em dias se for plausível, senão None (= não
    estimável). Único ponto de sanidade de data do sistema — todo
    detector que derive dias de uma data externa passa por aqui."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value != value or value in (float("inf"), float("-inf")):  # NaN/inf
        return None
    ivalue = int(value)
    if ivalue < SANE_DAYS_MIN or ivalue > SANE_DAYS_MAX:
        return None
    return ivalue


def normalize_entity(raw: str) -> str:
    """
    Sessão 4, Tarefa 4 — a entidade é normalizada ANTES do fingerprint.

    `INC-59` (ip:190.102.43.248) e `INC-58` (domain:190.102.43.248) eram
    o mesmo endereço rotulado de duas formas, virando dois incidentes
    críticos irmãos sem relação aparente. Um IPv4 é sempre `ip:`,
    independente de qual detector o produziu e de como o rótulo textual
    veio — o fingerprint não pode depender do rótulo.
    """
    raw = (raw or "").strip()
    if not raw:
        return ""
    prefix, _, value = raw.partition(":")
    if not value:
        prefix, value = "", raw
    try:
        ipaddress.ip_address(value)
        return f"ip:{value}"
    except ValueError:
        pass
    return raw if prefix else value


def make_fingerprint(detector_type: str, subtype: str, server_id: int, entity: str) -> str:
    """
    Chave de deduplicação. `subtype` entra na chave porque dois problemas
    genuinamente diferentes podem existir sobre a MESMA entidade — o IP
    de saída listado numa blocklist e o certificado daquele mesmo host
    vencendo são incidentes distintos, não um só. Sem o subtipo eles se
    fundiriam ao normalizar a entidade (T4).
    """
    return f"{detector_type}:{subtype}:{server_id}:{normalize_entity(entity)}"


class Candidate(TypedDict):
    type: str
    subtype: str   # distingue problemas diferentes do mesmo tipo sobre a mesma entidade
    entity: str
    severity: str  # "critico" | "atencao"
    metrics: Dict[str, Any]
    suggested_fix: Dict[str, Any]  # {"description": str, "action": {"action":..,"param":..} | None}
    triggered_by: Dict[str, Any]  # {"rule": str, "threshold": .., "observed": ..}
    evidence_hint: Dict[str, Any]  # dados p/ incident_engine montar a evidência do tipo (T7)


class CheckOutcome(TypedDict):
    """
    Resultado de UMA verificação — inclusive as que passaram e as que não
    puderam ser feitas. `reason` é obrigatório quando `status` != "ok":
    é o texto que a interface mostra em "não foi possível verificar — X".
    `detail` carrega a evidência específica daquele tipo de checagem
    (zona/resposta bruta/resolver para DNSBL; emissor/validade/hostname
    para certificado — Tarefa 7).
    """
    key: str
    label: str
    status: str
    reason: str
    detail: Dict[str, Any]


DetectorResult = Tuple[List[Candidate], List[CheckOutcome]]


def _check(key: str, label: str, status: str, reason: str = "", **detail: Any) -> CheckOutcome:
    return CheckOutcome(key=key, label=label, status=status, reason=reason, detail=detail)


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
                      baseline_fn: BaselineFn) -> DetectorResult:
    th = _cfg(config, "auth_abuse")
    out: List[Candidate] = []
    checks: List[CheckOutcome] = []

    diversity = data.get("auth_ip_diversity")
    if diversity is None:
        # A coleta não trouxe o campo — não é "nenhuma conta abusando",
        # é "não deu pra olhar". Sem isto, um log ilegível viraria um
        # servidor saudável (Tarefa 1).
        return [], [_check(
            "auth_abuse", "Contas SMTP",
            STATUS_DESCONHECIDO,
            "a coleta não trouxe a diversidade de IPs por conta autenticada — "
            "log não lido ou formato não reconhecido",
        )]

    for entry in diversity:
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
            subtype="conta",
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
            evidence_hint={"kind": "log_lines", "log_filter": "sent", "match": user},
        ))

    if out:
        checks.append(_check(
            "auth_abuse", "Contas SMTP", STATUS_CRITICO,
            f"{len(out)} conta(s) com padrão de credencial comprometida",
            accounts=[c["entity"] for c in out],
        ))
    else:
        checks.append(_check(
            "auth_abuse", "Contas SMTP", STATUS_OK, "",
            accounts_checked=len(diversity),
        ))
    return out, checks


# ============================================================
# 2. reputation — reputação de entrega em risco
# ============================================================
def detect_reputation(deliverability: Optional[Dict[str, Any]], data: Dict[str, Any],
                      config: Optional[Dict[str, Any]]) -> DetectorResult:
    """
    Três subcheagens independentes — blocklist, autenticação de DNS e
    certificado. Cada uma tem o próprio `subtype`, então o IP listado e o
    certificado vencendo do mesmo host são incidentes distintos e não se
    fundem ao normalizar a entidade (Tarefa 4).
    """
    if not deliverability:
        return [], [_check(
            "reputation", "Reputação de entrega", STATUS_DESCONHECIDO,
            "a checagem de entregabilidade não pôde ser executada no servidor "
            "(SSH indisponível ou o script não respondeu)",
        )]

    th = _cfg(config, "reputation")
    out: List[Candidate] = []
    checks: List[CheckOutcome] = []
    domain = deliverability.get("domain") or ""
    ip = deliverability.get("ip") or ""
    top_sender_count = int(data.get("top_sender_count") or 0)

    # ── Blocklist (DNSBL) ──────────────────────────────────────────
    # O script (check_blacklists_json) devolve, por zona, um `status`
    # explícito: "listado" | "limpo" | "desconhecido". Antes só existia
    # um booleano `listed`, e uma consulta RECUSADA pela Spamhaus
    # (resposta 127.255.255.x) entrava como listagem — o INC-59 inteiro.
    # Aqui `listed=True` sozinho não basta: só conta como listagem quem
    # tem status "listado".
    blocklists = deliverability.get("blocklists") or []
    listed = [b for b in blocklists if b.get("status") == "listado"]
    unknown_zones = [b for b in blocklists if b.get("status") == "desconhecido"]
    checked_zones = [b for b in blocklists if b.get("status") in ("listado", "limpo")]

    if not blocklists:
        checks.append(_check(
            "reputation.blocklist", "Blocklists (DNSBL)", STATUS_DESCONHECIDO,
            deliverability.get("blocklist_reason")
            or "nenhuma zona DNSBL foi consultada nesta coleta",
            ip=ip,
        ))
    elif listed and ip:
        names = ", ".join(b.get("list", "?") for b in listed)
        out.append(Candidate(
            type="reputation",
            subtype="blocklist",
            entity=f"ip:{ip}",
            severity="critico",
            metrics={
                "blocklists_listed": [b.get("list") for b in listed],
                "zones_listed": len(listed),
                "zones_checked": len(checked_zones),
                "zones_unknown": len(unknown_zones),
                "ip": ip,
            },
            suggested_fix={
                "description": (
                    f"O IP de saída {ip} está listado em {len(listed)} blocklist(s) "
                    f"({names}) — provedores como Gmail/Outlook começam a rejeitar ou "
                    f"jogar em spam a partir daqui. Não há correção de um clique: é "
                    f"preciso identificar e parar a origem do envio abusivo (ver os "
                    f"incidentes de conta comprometida e de fila travada deste mesmo "
                    f"servidor) e depois solicitar remoção no site de cada blocklist."
                ),
                "action": None,
            },
            triggered_by={"rule": "reputation.blocklist", "threshold": 1, "observed": len(listed)},
            evidence_hint={"kind": "dnsbl", "zones": listed + unknown_zones,
                           "resolver": deliverability.get("blocklist_resolver"),
                           "ip": ip},
        ))
        checks.append(_check(
            "reputation.blocklist", "Blocklists (DNSBL)", STATUS_CRITICO,
            f"listado em {names}",
            ip=ip, zones=blocklists, resolver=deliverability.get("blocklist_resolver"),
        ))
    elif not checked_zones:
        # TODAS as zonas voltaram indeterminadas — não é "limpo".
        reasons = {b.get("reason") for b in unknown_zones if b.get("reason")}
        checks.append(_check(
            "reputation.blocklist", "Blocklists (DNSBL)", STATUS_DESCONHECIDO,
            "; ".join(sorted(reasons)) or "nenhuma zona DNSBL respondeu de forma conclusiva",
            ip=ip, zones=blocklists, resolver=deliverability.get("blocklist_resolver"),
        ))
    else:
        checks.append(_check(
            "reputation.blocklist", "Blocklists (DNSBL)", STATUS_OK,
            (f"{len(unknown_zones)} de {len(blocklists)} zonas não puderam ser consultadas"
             if unknown_zones else ""),
            ip=ip, zones=blocklists, resolver=deliverability.get("blocklist_resolver"),
        ))

    # ── SPF/DKIM/DMARC ausente (só importa se o domínio envia volume) ──
    if not domain:
        checks.append(_check(
            "reputation.dns_auth", "SPF / DKIM / DMARC", STATUS_DESCONHECIDO,
            "nenhum domínio de envio foi identificado neste servidor — sem domínio "
            "não há registro de DNS para conferir",
        ))
    elif top_sender_count < th["min_volume_for_dns_check"]:
        checks.append(_check(
            "reputation.dns_auth", "SPF / DKIM / DMARC", STATUS_OK,
            f"volume recente abaixo de {th['min_volume_for_dns_check']} mensagens — "
            f"registros ausentes ainda não afetam entrega de ninguém",
            domain=domain, recent_volume=top_sender_count,
        ))
    else:
        missing = []
        found = {}
        for key, label in (("spf", "SPF"), ("dkim", "DKIM"), ("dmarc", "DMARC")):
            comp = deliverability.get(key) or {}
            found[label] = bool(comp.get("found"))
            if not comp.get("found"):
                missing.append(label)
        if missing:
            out.append(Candidate(
                type="reputation",
                subtype="dns_auth",
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
                evidence_hint={"kind": "dns_auth", "domain": domain,
                               "records": {k: deliverability.get(k) for k in ("spf", "dkim", "dmarc")}},
            ))
            checks.append(_check(
                "reputation.dns_auth", "SPF / DKIM / DMARC", STATUS_CRITICO,
                f"faltando {', '.join(missing)} em {domain}",
                domain=domain, found=found,
                records={k: deliverability.get(k) for k in ("spf", "dkim", "dmarc")},
            ))
        else:
            checks.append(_check(
                "reputation.dns_auth", "SPF / DKIM / DMARC", STATUS_OK, "",
                domain=domain, found=found,
            ))

    # ── Certificado TLS ──────────────────────────────────────────────
    cert = deliverability.get("cert") or {}
    cert_status = cert.get("status")
    days_remaining = sane_days(cert.get("days_remaining"))
    cert_detail = {
        "hostname": cert.get("hostname"), "hostname_source": cert.get("hostname_source"),
        "sni_sent": cert.get("sni_sent"), "issuer": cert.get("issuer"),
        "subject": cert.get("subject"), "sans": cert.get("sans"),
        "expires_at": cert.get("expires_at"), "starts_at": cert.get("starts_at"),
        "days_remaining": days_remaining, "not_after_raw": cert.get("not_after_raw"),
        "hostname_matches": cert.get("hostname_matches"),
    }

    if not cert:
        checks.append(_check(
            "reputation.cert", "Certificado TLS", STATUS_DESCONHECIDO,
            "a coleta não trouxe informação de certificado",
        ))
    elif cert_status == "desconhecido" or days_remaining is None:
        # Aceite da Tarefa 1: sem hostname para SNI, data implausível ou
        # handshake sem certificado ⇒ "não foi possível verificar", com o
        # motivo que o próprio script apurou. Nunca um incidente.
        checks.append(_check(
            "reputation.cert", "Certificado TLS", STATUS_DESCONHECIDO,
            cert.get("reason") or "o certificado não pôde ser verificado",
            **cert_detail,
        ))
    elif days_remaining < 0:
        out.append(Candidate(
            type="reputation", subtype="cert",
            entity=f"host:{cert.get('hostname') or domain or 'desconhecido'}",
            severity="critico",
            metrics={"days_remaining": days_remaining, "expired": True,
                     "hostname": cert.get("hostname"), "issuer": cert.get("issuer")},
            suggested_fix={
                "description": (
                    f"O certificado TLS de {cert.get('hostname')} venceu há "
                    f"{abs(days_remaining)} dia(s) (emissor: {cert.get('issuer') or 'desconhecido'}). "
                    f"Entregas com TLS obrigatório já devem estar falhando. Renovar o "
                    f"certificado no servidor — fora do alcance deste painel."
                ),
                "action": None,
            },
            triggered_by={"rule": "reputation.cert_expired", "threshold": 0, "observed": days_remaining},
            evidence_hint={"kind": "cert", **cert_detail},
        ))
        checks.append(_check("reputation.cert", "Certificado TLS", STATUS_CRITICO,
                             f"vencido há {abs(days_remaining)} dia(s)", **cert_detail))
    elif days_remaining <= th["cert_days_warn"]:
        out.append(Candidate(
            type="reputation", subtype="cert",
            entity=f"host:{cert.get('hostname') or domain or 'desconhecido'}",
            severity="atencao",
            metrics={"days_remaining": days_remaining, "expired": False,
                     "hostname": cert.get("hostname"), "issuer": cert.get("issuer")},
            suggested_fix={
                "description": (
                    f"O certificado TLS de {cert.get('hostname')} expira em "
                    f"{days_remaining} dia(s). Renovar antes do vencimento para não "
                    f"quebrar entregas com TLS obrigatório."
                ),
                "action": None,
            },
            triggered_by={"rule": "reputation.cert_expiring",
                          "threshold": th["cert_days_warn"], "observed": days_remaining},
            evidence_hint={"kind": "cert", **cert_detail},
        ))
        checks.append(_check("reputation.cert", "Certificado TLS", STATUS_ALERTA,
                             f"expira em {days_remaining} dia(s)", **cert_detail))
    else:
        checks.append(_check("reputation.cert", "Certificado TLS", STATUS_OK, "", **cert_detail))

    return out, checks


# ============================================================
# 3. queue_stuck — fila travada
# ============================================================
def detect_queue_stuck(recent_full_snapshots: List[Dict[str, Any]], data: Dict[str, Any],
                       config: Optional[Dict[str, Any]], baseline_fn: BaselineFn) -> DetectorResult:
    """
    `recent_full_snapshots` = últimos N Snapshot.data (mode="full"),
    mais recente primeiro, já incluindo o ciclo atual — quem chama
    (incident_engine.py) monta essa lista a partir do histórico
    persistido, não este módulo.
    """
    th = _cfg(config, "queue_stuck")
    out: List[Candidate] = []
    checks: List[CheckOutcome] = []

    if data.get("error") or (data.get("queue") is None and not recent_full_snapshots):
        return [], [_check(
            "queue_stuck", "Fila de mensagens", STATUS_DESCONHECIDO,
            str(data.get("error") or "a coleta não trouxe o estado da fila"),
        )]

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
                subtype="fila",
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
                evidence_hint={"kind": "log_lines",
                               "log_filter": "deferred" if cause == "destino" else "sent",
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
                subtype="frozen",
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
                evidence_hint={"kind": "log_lines", "log_filter": "deferred", "match": ""},
            ))

    current_queue = ((recent_full_snapshots[0] if recent_full_snapshots else {}).get("queue") or {})
    if out:
        checks.append(_check(
            "queue_stuck", "Fila de mensagens", STATUS_CRITICO,
            "; ".join(c["metrics"].get("cause", c["subtype"]) for c in out),
            queue_total=current_queue.get("total"), frozen=current_queue.get("frozen"),
        ))
    else:
        checks.append(_check(
            "queue_stuck", "Fila de mensagens", STATUS_OK, "",
            queue_total=current_queue.get("total"), frozen=current_queue.get("frozen"),
            cycles_available=len(recent_full_snapshots),
        ))
    return out, checks


# ============================================================
# 4. dest_deferral — rate limit de destino (sempre atenção)
# ============================================================
def detect_dest_deferral(data: Dict[str, Any], config: Optional[Dict[str, Any]]) -> DetectorResult:
    th = _cfg(config, "dest_deferral")
    out: List[Candidate] = []
    ok_check = [_check("dest_deferral", "Adiamentos por destino", STATUS_OK, "")]

    domains = data.get("top_defer_domains") or []
    if not domains:
        return out, ok_check

    total_deferred = sum(int(d.get("count") or 0) for d in domains)
    if total_deferred <= 0:
        return out, ok_check

    top = max(domains, key=lambda d: int(d.get("count") or 0))
    count = int(top.get("count") or 0)
    domain = top.get("domain") or ""
    share = count / total_deferred if total_deferred else 0

    if not domain or count < th["min_count"] or share < th["min_share"]:
        return out, ok_check

    out.append(Candidate(
        type="dest_deferral",
        subtype="destino",
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
        evidence_hint={"kind": "log_lines", "log_filter": "deferred", "match": domain},
    ))

    return out, [_check(
        "dest_deferral", "Adiamentos por destino", STATUS_ALERTA,
        f"{domain} concentra {int(share * 100)}% dos adiamentos",
        domain=domain, deferred_count=count, total_deferred=total_deferred,
    )]
