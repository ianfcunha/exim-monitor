"""
Watchdog do coletor — quem vigia o vigia.

O painel inteiro depende de uma única `asyncio.Task` continuar rodando.
Se ela morre ou trava, nada no sistema percebe: as telas seguem servindo o
último snapshot, o selo de saúde segue verde, e nenhum alerta dispara —
porque alerta é disparado PELA coleta. A falha do monitoramento é
silenciosa, e silêncio é indistinguível de "está tudo bem". Para um
produto cujo argumento de venda é justamente avisar antes do cliente
ligar, esse é o pior defeito possível.

Três modos de falha, três respostas:

  1. A task MORREU (exceção que escapou do loop, cancelamento indevido).
     → o watchdog religa e alerta. Detectável por `task.done()`.

  2. A task está VIVA mas TRAVADA — um `await` que nunca volta. Acontece
     de verdade: `asyncio.gather` sobre uma coleta SSH pendurada espera
     para sempre, e o `try/except` do loop não pega isso porque não há
     exceção nenhuma. → detectado por heartbeat velho; o watchdog cancela
     e religa.

  3. O coletor está saudável, mas UM SERVIDOR ficou mudo (SSH quebrado,
     host desligado, credencial ilegível). Hoje isso vira `ssh_status`
     vermelho na tela e mais nada — quem não estiver com o painel aberto
     não fica sabendo. → alerta deadman por servidor, com aviso de
     recuperação quando ele volta.

O watchdog não tem um watchdog. Ele é um loop deliberadamente burro: um
`sleep`, quatro comparações de data e um alerta. Tudo que pode levantar
exceção está dentro de `try`, e o loop nunca sai do `while` — se ele
falhasse em silêncio, teríamos apenas movido o problema um nível acima.
"""
import asyncio
import logging
from datetime import datetime, timedelta
from typing import Any, Dict, Optional, Set

from .config import settings

logger = logging.getLogger(__name__)

# Frequência da vigília. Não precisa ser fina: os limiares abaixo são de
# minutos, e um watchdog que acorda demais é só custo.
WATCHDOG_INTERVAL = 60

# Coletor considerado travado depois disto sem um tick. Quatro ciclos quick
# (120s no padrão) dá folga para uma coleta lenta sem deixar passar uma
# parada real; o piso de 180s protege configurações com quick_interval
# muito baixo.
def _stall_threshold() -> timedelta:
    return timedelta(seconds=max(settings.quick_interval * 4, 180))


# Servidor considerado silencioso depois disto sem uma coleta bem-sucedida.
# 15 minutos no padrão — o mesmo limiar que o indicador de frescor do
# cabeçalho já usa, para a faixa vermelha da tela e o alerta contarem a
# mesma história em vez de duas.
def _silence_threshold() -> timedelta:
    return timedelta(seconds=max(settings.full_interval * 3, 900))


# ── Heartbeat ──────────────────────────────────────────────────────────────
# Em memória de propósito: o que se quer saber é se ESTE processo ainda
# está coletando. Se ele reiniciou, o coletor reiniciou junto, e um
# heartbeat persistido de antes do restart só produziria um alerta falso.

_last_tick_at: Optional[datetime] = None
_last_tick_mode: Optional[str] = None
_cycles: int = 0
_started_at: Optional[datetime] = None
_restarts: int = 0

# Servidores para os quais já avisamos que estão mudos, para o aviso de
# recuperação sair uma vez só quando voltarem.
_silent_servers: Set[int] = set()
_collector_alarm = False


def note_cycle(mode: str) -> None:
    """Chamado pelo coletor ao FIM de cada ciclo — é o pulso que o
    watchdog escuta. No fim, não no começo: um ciclo que entrou e travou
    no meio não deve contar como sinal de vida."""
    global _last_tick_at, _last_tick_mode, _cycles
    _last_tick_at = datetime.utcnow()
    _last_tick_mode = mode
    _cycles += 1


def collector_health() -> Dict[str, Any]:
    """Estado do coletor — consumido pela API e pelo pacote de suporte."""
    now = datetime.utcnow()
    age = (now - _last_tick_at).total_seconds() if _last_tick_at else None
    task = _collector_task
    alive = bool(task and not task.done())
    stalled = bool(_last_tick_at and (now - _last_tick_at) > _stall_threshold())

    if not alive:
        state = "parado"
    elif stalled:
        state = "travado"
    elif _last_tick_at is None:
        state = "iniciando"
    else:
        state = "coletando"

    return {
        "state":              state,
        "task_alive":         alive,
        "last_cycle_at":      _last_tick_at.isoformat() + "Z" if _last_tick_at else None,
        "last_cycle_mode":    _last_tick_mode,
        "seconds_since_cycle": int(age) if age is not None else None,
        "cycles":             _cycles,
        "restarts":           _restarts,
        "started_at":         _started_at.isoformat() + "Z" if _started_at else None,
        "stall_after_seconds": int(_stall_threshold().total_seconds()),
        "silence_after_seconds": int(_silence_threshold().total_seconds()),
        "silent_servers":     sorted(_silent_servers),
    }


# ── Supervisão da task ─────────────────────────────────────────────────────

_collector_task: Optional[asyncio.Task] = None


def start_collector() -> asyncio.Task:
    """Cria a task do coletor. O watchdog religa por aqui também, então
    existe um lugar só que sabe como o coletor nasce."""
    global _collector_task, _started_at
    from .collector import background_collector

    _collector_task = asyncio.create_task(background_collector())
    if _started_at is None:
        _started_at = datetime.utcnow()
    return _collector_task


async def stop_collector() -> None:
    """Encerra o coletor no shutdown. Usa a referência viva do módulo —
    depois de um religamento, a task que o lifespan guardou já é outra."""
    global _collector_task
    task = _collector_task
    _collector_task = None
    if task is None or task.done():
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass
    except Exception:
        logger.exception("Coletor terminou com erro durante o shutdown")


async def _restart_collector(reason: str) -> None:
    global _restarts, _last_tick_at
    task = _collector_task
    if task is not None and not task.done():
        task.cancel()
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=10)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            # Travado a ponto de não responder ao cancel: seguimos e
            # criamos a task nova mesmo assim. Uma task pendurada num
            # socket é um vazamento; um painel cego é um incidente.
            pass
        except Exception:
            logger.exception("Coletor terminou com erro ao ser reiniciado")
    _last_tick_at = None
    _restarts += 1
    start_collector()
    logger.warning("Coletor reiniciado pelo watchdog (%s) — reinício nº %d", reason, _restarts)


# ── O loop ────────────────────────────────────────────────────────────────

async def _check_collector() -> None:
    """Modos de falha 1 e 2: a task morreu, ou está viva e travada."""
    global _collector_alarm
    from .alerts import clear_operational_cooldown, send_operational_alert

    task = _collector_task
    now = datetime.utcnow()

    dead = task is None or task.done()
    stalled = _last_tick_at is not None and (now - _last_tick_at) > _stall_threshold()

    if not (dead or stalled):
        if _collector_alarm:
            _collector_alarm = False
            clear_operational_cooldown("coletor_parado", None)
            await send_operational_alert(
                kind="coletor_parado",
                title="Coleta retomada",
                detail="O coletor voltou a rodar e os servidores estão sendo monitorados novamente.",
                resolved=True,
            )
            logger.info("Coletor voltou ao normal")
        return

    if dead:
        reason = "a task do coletor terminou"
        # Se morreu por exceção, ela está guardada na task e é o dado mais
        # útil que existe sobre esta falha — sem isto, ela some para sempre.
        if task is not None and task.done() and not task.cancelled():
            exc = task.exception()
            if exc is not None:
                logger.error("Coletor morreu com exceção", exc_info=exc)
                reason = f"a task do coletor morreu: {exc.__class__.__name__}: {exc}"
    else:
        idade = int((now - _last_tick_at).total_seconds())
        reason = f"nenhum ciclo de coleta concluído há {idade}s"

    logger.critical("WATCHDOG: %s — religando", reason)
    _collector_alarm = True
    await send_operational_alert(
        kind="coletor_parado",
        title="A coleta parou",
        detail=(
            f"O Mail IQ deixou de coletar dados dos servidores monitorados "
            f"({reason}). O watchdog está religando a coleta automaticamente. "
            "Enquanto isso, os dados no painel não estão sendo atualizados e "
            "nenhum incidente novo será detectado. Se este aviso se repetir, "
            "envie o pacote de diagnóstico ao suporte."
        ),
    )
    await _restart_collector(reason)


async def _check_silent_servers() -> None:
    """Modo de falha 3: o coletor roda, mas um servidor não responde."""
    from .alerts import clear_operational_cooldown, send_operational_alert
    from .database import Server, SessionLocal

    limite = _silence_threshold()
    now = datetime.utcnow()

    db = SessionLocal()
    try:
        servers = db.query(Server).filter(Server.is_enabled == True).all()  # noqa: E712
        estado = [
            (s.id, s.name, s.last_connected_at, s.ssh_status, s.ssh_error_msg)
            for s in servers
        ]
    finally:
        db.close()

    ativos = {sid for sid, *_ in estado}
    # Servidor removido ou desativado enquanto estava mudo não deve ficar
    # preso no conjunto — nem gerar um "voltou" que nunca aconteceu.
    for gone in _silent_servers - ativos:
        _silent_servers.discard(gone)
        clear_operational_cooldown("servidor_silencioso", gone)

    for sid, nome, last_ok, ssh_status, ssh_error in estado:
        # Servidor recém-cadastrado que nunca conectou não é "silencioso":
        # não houve nada para emudecer. Isso é problema de cadastro, e a
        # tela de Servidores já mostra o erro do teste de conexão.
        if last_ok is None:
            continue

        mudo = (now - last_ok) > limite

        if mudo and sid not in _silent_servers:
            _silent_servers.add(sid)
            minutos = int((now - last_ok).total_seconds() // 60)
            motivo = f" Último erro: {ssh_error}" if ssh_error else ""
            logger.warning(
                "WATCHDOG: servidor %s (%s) sem coleta há %d min (ssh_status=%s)",
                sid, nome, minutos, ssh_status,
            )
            await send_operational_alert(
                kind="servidor_silencioso",
                title="Servidor sem resposta",
                detail=(
                    f"O Mail IQ não consegue coletar dados deste servidor há "
                    f"{minutos} minutos. Ele continua cadastrado e as tentativas "
                    f"seguem, mas nenhum problema de e-mail neste servidor será "
                    f"detectado enquanto ele não responder.{motivo}"
                ),
                server_id=sid,
            )
        elif not mudo and sid in _silent_servers:
            _silent_servers.discard(sid)
            logger.info("WATCHDOG: servidor %s (%s) voltou a responder", sid, nome)
            await send_operational_alert(
                kind="servidor_silencioso",
                title="Servidor voltou a responder",
                detail="A coleta deste servidor foi restabelecida e o monitoramento está normal.",
                server_id=sid,
                resolved=True,
            )


async def watchdog_loop() -> None:
    """
    O loop. Nada aqui pode levantar para fora: se o watchdog cair, a única
    coisa que sobra vigiando o coletor é ninguém.
    """
    logger.info(
        "Watchdog do coletor iniciado — verifica a cada %ds; alerta se não houver "
        "ciclo há %ds ou se um servidor ficar sem coleta por %ds",
        WATCHDOG_INTERVAL,
        int(_stall_threshold().total_seconds()),
        int(_silence_threshold().total_seconds()),
    )
    while True:
        await asyncio.sleep(WATCHDOG_INTERVAL)
        try:
            await _check_collector()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Erro na verificação do coletor (watchdog segue)")
        try:
            await _check_silent_servers()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Erro na verificação de servidores silenciosos (watchdog segue)")
