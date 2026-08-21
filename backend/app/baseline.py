"""
Sessão 2, Tarefa 3 — baseline por servidor e por conta.

Guarda métricas horárias dos últimos 30 dias, para os detectores
(detectors.py) comparar cada coisa contra a própria história em vez de
um threshold fixo — que gera alarme falso na primeira semana e o
cliente desliga o alerta (a forma real de morrer aqui).

Uma amostra por (server_id, entity, metric, hour_of_day, dia) — chamado
a cada ciclo full (collector.py), mas dedupicado por dia: a última
leitura do dia sobrescreve a anterior do mesmo dia (não acumula 1
amostra por tick de 5min, senão "30 dias" viraria "30 leituras", ~2.5h).
"""
import logging
import statistics
from datetime import datetime
from typing import Any, Dict, Optional

from .database import BaselineMetric

logger = logging.getLogger(__name__)

BASELINE_MAX_DAYS = 30
# Metrica só é considerada "confiável" (usada por um detector) a partir
# deste número de dias distintos amostrados — ver min_baseline_samples
# em detectors.DEFAULT_THRESHOLDS.
MIN_SAMPLES_FOR_USE = 5


def record_sample(db, server_id: int, entity: str, metric: str, value: float,
                  at: Optional[datetime] = None) -> None:
    """
    Grava (ou atualiza, se já existe uma amostra hoje) o valor observado
    para (server_id, entity, metric) na hora-do-dia de `at` (default:
    agora, UTC — mesma convenção do resto do schema, que nunca usa
    datetime.now()). Nunca levanta — amostragem de baseline é
    best-effort, não pode derrubar o ciclo de coleta.
    """
    at = at or datetime.utcnow()
    hour = at.hour
    day_key = at.strftime("%Y-%m-%d")

    try:
        row = (
            db.query(BaselineMetric)
            .filter(
                BaselineMetric.server_id == server_id,
                BaselineMetric.entity == entity,
                BaselineMetric.metric == metric,
                BaselineMetric.hour_of_day == hour,
            )
            .first()
        )
        if row is None:
            row = BaselineMetric(
                server_id=server_id, entity=entity, metric=metric, hour_of_day=hour,
                samples=[],
            )
            db.add(row)

        samples = list(row.samples or [])
        samples = [s for s in samples if s.get("day") != day_key]
        samples.append({"day": day_key, "value": float(value)})
        # Mais antigo primeiro — corta o excesso pela ponta velha.
        samples.sort(key=lambda s: s["day"])
        if len(samples) > BASELINE_MAX_DAYS:
            samples = samples[-BASELINE_MAX_DAYS:]

        row.samples = samples
        values = [s["value"] for s in samples]
        row.mean = statistics.fmean(values) if values else None
        row.stddev = statistics.pstdev(values) if len(values) >= 2 else 0.0
        db.commit()
    except Exception:
        db.rollback()
        logger.exception(
            "Falha ao gravar amostra de baseline (server_id=%s entity=%s metric=%s)",
            server_id, entity, metric,
        )


def get_baseline(db, server_id: int, entity: str, metric: str,
                 at: Optional[datetime] = None) -> Optional[Dict[str, Any]]:
    """
    Retorna {"mean": float, "stddev": float, "samples": int} para a
    hora-do-dia de `at` (default: agora), ou None se nunca amostrado.
    Detectores devem checar `samples` contra o próprio mínimo antes de
    usar `mean` — ver DEFAULT_THRESHOLDS em detectors.py.
    """
    at = at or datetime.utcnow()
    row = (
        db.query(BaselineMetric)
        .filter(
            BaselineMetric.server_id == server_id,
            BaselineMetric.entity == entity,
            BaselineMetric.metric == metric,
            BaselineMetric.hour_of_day == at.hour,
        )
        .first()
    )
    if row is None or row.mean is None:
        return None
    return {"mean": row.mean, "stddev": row.stddev or 0.0, "samples": len(row.samples or [])}


def make_baseline_fn(db, server_id: int):
    """Fecha (db, server_id) num callable no formato que detectors.py
    espera (BaselineFn: (entity, metric) -> stats|None) — usado por
    incident_engine.py ao chamar os detectores."""
    def _fn(entity: str, metric: str) -> Optional[Dict[str, Any]]:
        return get_baseline(db, server_id, entity, metric)
    return _fn


def record_cycle_samples(db, server_id: int, data: Dict[str, Any], at: Optional[datetime] = None) -> None:
    """
    Chamado por collector.py a cada ciclo full — extrai do JSON completo
    do diag-exim.sh as métricas que os detectores comparam contra
    baseline: queue_total no nível de servidor (entity="") e o volume de
    autenticação de cada conta que apareceu em auth_ip_diversity neste
    ciclo (entity=<usuário>) — só as contas realmente ativas, não uma
    varredura de todas as contas já vistas historicamente.
    """
    queue_total = ((data.get("queue") or {}).get("total"))
    if queue_total is not None:
        record_sample(db, server_id, "", "queue_total", queue_total, at=at)

    for entry in data.get("auth_ip_diversity") or []:
        user = entry.get("user")
        count = entry.get("count")
        if user and count is not None:
            record_sample(db, server_id, user, "auth_volume", count, at=at)
