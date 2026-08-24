/**
 * Plano de correção — Sessão 6, handoff Mail IQ 2.0.
 *
 * Reskin do fluxo diagnóstico → correção que já existe em
 * IncidentDetail.jsx (Triagem) e ActionPanel.jsx, na apresentação
 * "banner + causa raiz/impacto + stepper + checklist + responsáveis +
 * timeline" do mockup — mas SEM inventar dado que o produto não tem.
 *
 * O mockup modela um stepper fixo de 4 etapas narrativas (Diagnóstico →
 * Isolamento → Correção → Verificação). A máquina de estados real
 * (incident_engine.py) não é essa: `aberto` → `em_observacao` (parou de
 * ser detectado, mas ainda dentro da janela de histerese — não é
 * "sendo corrigido", é "esfriando, ainda não confirmado") → `mitigado`
 * (setado só quando a correção sugerida é aplicada) → `resolvido`. Em
 * vez de forçar a narrativa do mockup sobre um estado que não a segue,
 * o stepper aqui usa os 4 estados REAIS como os 4 nós — mesma forma
 * visual, sem fingir uma etapa que o sistema não tem.
 *
 * A checklist e o "responsáveis" vêm de `events` (IncidentEvent —
 * máquina de estados append-only, com actor e timestamp) e do fluxo
 * plan()→apply() já validado em IncidentDetail — não de um checklist
 * fixo que o mockup inventa.
 */
import {
  AlertTriangle, Check, CheckCircle2, ClipboardList, ShieldOff,
} from 'lucide-react'
import { Fragment, useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ackIncident, applyIncidentFix, fetchIncident, fetchIncidents,
  planIncidentFix, resolveIncident, silenceIncident,
} from '../api/client'
import { Button } from '@/components/ui/button'
import {
  SEVERITY_STYLE, STATUS_LABELS, applyLabel, fmtAge, incidentTitle,
} from '../components/incidents/incidentLabels'
import { useServer } from '../contexts/ServerContext'
import { useToast } from '../contexts/ToastContext'

const STATUS_ORDER = ['aberto', 'em_observacao', 'mitigado', 'resolvido']

const EVENT_LABELS = {
  opened: 'Incidente aberto', escalated: 'Agravado — condição piorou',
  ack: 'Ciência confirmada', silenced: 'Silenciado',
  mitigated: 'Marcado como mitigado', resolved: 'Resolvido',
  reopened: 'Reaberto — voltou a ser detectado',
  // Emitidos pelo motor de detecção (incident_engine.py) fora do trio
  // opened/mitigated/resolved documentado em Incident — não é uma
  // transição de status, é o log de por que a confirmação demorou.
  check_unknown: 'Checagem sem resposta durante a reverificação',
  unverified: 'Não foi possível reverificar — checagem falhou',
}

function fmtDateTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('pt-BR')
}
function fmtTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}
function fmtDuration(seconds) {
  if (seconds == null) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  if (h === 0) return `${m}min`
  return `${h}h${m > 0 ? ` ${m}min` : ''}`
}
function initials(name) {
  return String(name || '?').trim().slice(0, 2).toUpperCase()
}

// ── Empty state: nenhum incidente aberto no momento ─────────────────────
function NoActiveIncident() {
  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '48px 24px', width: '100%' }}>
      <div style={{
        background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
        padding: '28px 24px', textAlign: 'center', maxWidth: 520, margin: '0 auto',
      }}>
        <ClipboardList size={22} color="var(--dim)" style={{ marginBottom: 10 }} />
        <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: '0 0 6px' }}>
          Nenhum incidente ativo no momento
        </p>
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 18px', lineHeight: 1.55 }}>
          O plano de correção aparece aqui assim que um incidente for detectado
          em qualquer servidor da frota. Para ver planos de incidentes já
          resolvidos, use a Triagem.
        </p>
        <Link to="/triage">
          <Button size="sm" variant="outline">Ir para a Triagem</Button>
        </Link>
      </div>
    </div>
  )
}

// ── Stepper — 4 estados reais do incidente, não uma narrativa fixa ──────
function Stepper({ status }) {
  const idx = STATUS_ORDER.indexOf(status)
  const resolved = status === 'resolvido'
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '22px 32px' }}>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', marginBottom: 20 }}>
        Estado do incidente
      </div>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        {STATUS_ORDER.map((s, i) => {
          // Resolvido fecha a história inteira — os nós anteriores contam
          // como concluídos ainda que o incidente tenha pulado
          // `mitigado` (resolução automática por histerese, sem correção
          // aplicada) — o que aconteceu de fato está na Timeline abaixo,
          // isto é só a posição no ciclo de vida.
          const done = resolved ? true : i < idx
          const current = !resolved && i === idx
          const circleBg = done ? 'var(--ok-bg)' : current ? 'var(--warn-bg)' : 'var(--surface-alt)'
          const circleBorder = done ? 'var(--ok)' : current ? 'var(--warn)' : 'var(--border)'
          return (
            <Fragment key={s}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9, flex: 'none', width: 140 }}>
                <div style={{
                  width: 38, height: 38, borderRadius: '50%', background: circleBg,
                  border: `2.5px solid ${circleBorder}`, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  animation: current ? 'pulse-sky 1.4s ease-in-out infinite' : undefined,
                }}>
                  {done ? (
                    <Check size={14} color="var(--ok)" strokeWidth={2.5} />
                  ) : current ? (
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--warn)' }} />
                  ) : (
                    <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--dim)' }}>{i + 1}</span>
                  )}
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: done ? 'var(--ok)' : current ? 'var(--warn)' : 'var(--dim)' }}>
                    {STATUS_LABELS[s]}
                  </div>
                </div>
              </div>
              {i < STATUS_ORDER.length - 1 && (
                <div style={{ flex: 1, height: 2.5, background: done ? 'var(--ok)' : 'var(--border)', marginBottom: 30 }} />
              )}
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

export default function PlanoPage() {
  const { id: routeId } = useParams()
  const toast = useToast()
  const { servers } = useServer()

  const [incident, setIncident] = useState(null)
  const [loading, setLoading]   = useState(true)
  const [notFoundActive, setNotFoundActive] = useState(false)
  const [busy, setBusy]         = useState(null)
  const [plan, setPlan]         = useState(null)
  const [planning, setPlanning] = useState(false)
  const [applying, setApplying] = useState(false)

  // Sem :id na rota — escolhe o incidente aberto mais severo da frota
  // inteira (crítico antes de atenção, mais recente primeiro), o mesmo
  // critério do banner de alerta do handoff.
  const loadDefault = useCallback(() => {
    setLoading(true)
    fetchIncidents({ status: 'aberto' }).then(rows => {
      if (rows.length === 0) { setIncident(null); setNotFoundActive(true); setLoading(false); return }
      const best = [...rows].sort((a, b) => {
        if (a.severity !== b.severity) return a.severity === 'critico' ? -1 : 1
        return new Date(b.last_seen) - new Date(a.last_seen)
      })[0]
      return fetchIncident(best.id).then(d => { setIncident(d); setNotFoundActive(false) })
    }).catch(() => { setIncident(null); setNotFoundActive(true) }).finally(() => setLoading(false))
  }, [])

  const loadById = useCallback((id) => {
    setLoading(true)
    fetchIncident(id).then(d => { setIncident(d); setNotFoundActive(false) })
      .catch(() => { setIncident(null); setNotFoundActive(true) })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (routeId) loadById(Number(routeId))
    else loadDefault()
  }, [routeId, loadById, loadDefault])

  // Poll leve — mesmo motivo da Triagem: esta é a tela que fica aberta
  // acompanhando o incidente em andamento.
  useEffect(() => {
    const id = setInterval(() => { routeId ? loadById(Number(routeId)) : loadDefault() }, 30_000)
    return () => clearInterval(id)
  }, [routeId, loadById, loadDefault])

  const refresh = () => (routeId ? loadById(Number(routeId)) : loadDefault())

  if (loading && !incident) {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--dim)', fontSize: 13 }}>Carregando…</div>
  }
  if (!incident || notFoundActive) {
    return <NoActiveIncident />
  }

  const sev = SEVERITY_STYLE[incident.severity] ?? SEVERITY_STYLE.atencao
  const isResolved = incident.status === 'resolvido'
  const fixAction = incident.suggested_fix?.action
  const server = servers.find(s => s.id === incident.server_id)
  const observationReason = server?.observation_mode
    ? `${server.name} está em modo observação — desligue em Configurações → Servidores para aplicar esta correção.`
    : null

  const events = [...(incident.events ?? [])].sort((a, b) => new Date(a.at) - new Date(b.at))
  const actors = [...new Set(events.map(e => e.actor).filter(a => a && a !== 'system'))]

  const doAck = async () => {
    setBusy('ack')
    try { await ackIncident(incident.id); refresh() }
    catch (err) { toast({ type: 'err', msg: err?.response?.data?.detail || 'Erro ao confirmar ciência.' }) }
    finally { setBusy(null) }
  }
  const doSilence = async () => {
    setBusy('silence')
    try { await silenceIncident(incident.id, 60); toast({ type: 'ok', msg: 'Silenciado por 60 minutos.' }); refresh() }
    catch (err) { toast({ type: 'err', msg: err?.response?.data?.detail || 'Erro ao silenciar.' }) }
    finally { setBusy(null) }
  }
  const doResolve = async () => {
    setBusy('resolve')
    try { await resolveIncident(incident.id, 'manual'); toast({ type: 'ok', msg: 'Incidente resolvido.' }); refresh() }
    catch (err) { toast({ type: 'err', msg: err?.response?.data?.detail || 'Erro ao resolver.' }) }
    finally { setBusy(null) }
  }
  const requestPlan = async () => {
    setPlanning(true)
    try { setPlan(await planIncidentFix(incident.id)) }
    catch (err) { toast({ type: 'err', msg: err?.response?.data?.detail || 'Erro ao planejar correção.' }) }
    finally { setPlanning(false) }
  }
  const applyFix = async () => {
    if (!plan) return
    setApplying(true)
    try {
      const res = await applyIncidentFix(incident.id, plan.plan_id)
      toast({ type: 'ok', msg: res.message || 'Correção aplicada.' })
      setPlan(null); refresh()
    } catch (err) { toast({ type: 'err', msg: err?.response?.data?.detail || 'Erro ao aplicar correção.' }) }
    finally { setApplying(false) }
  }

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '20px 24px 32px', width: '100%', display: 'flex', flexDirection: 'column', gap: 16 }}>

      {/* ── Banner ── */}
      <div style={{
        background: sev.bg, border: `1.5px solid ${sev.border}`, borderRadius: 12,
        padding: '16px 20px', display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap',
      }}>
        {!isResolved && (
          <span style={{
            width: 10, height: 10, borderRadius: '50%', background: sev.text, flexShrink: 0, marginTop: 5,
            animation: 'pulse-sky 1.4s ease-in-out infinite', display: 'block',
          }} />
        )}
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 15.5, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.01em', marginBottom: 3 }}>
            {incidentTitle(incident)}
          </div>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{incident.display_id}</span>
            {' · '}{incident.server_name ?? `servidor #${incident.server_id}`}
            {' · iniciado às '}{fmtTime(incident.first_seen)}
            {' · '}{STATUS_LABELS[incident.status]}
          </div>
        </div>
        {!isResolved && (
          <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
            <Button size="sm" variant="outline" onClick={doAck} disabled={!!busy}>
              <Check size={12} /> {busy === 'ack' ? 'Confirmando…' : 'Confirmar ciência'}
            </Button>
            <Button size="sm" variant="outline" onClick={doSilence} disabled={!!busy}>
              <ShieldOff size={12} /> {busy === 'silence' ? 'Silenciando…' : 'Silenciar 60min'}
            </Button>
            <Button size="sm" onClick={doResolve} disabled={!!busy}>
              <CheckCircle2 size={12} /> {busy === 'resolve' ? 'Resolvendo…' : 'Resolver'}
            </Button>
          </div>
        )}
      </div>

      {/* ── Causa raiz + Impacto ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }} className="plano-2col">
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>Causa raiz</div>
          <Row label="Servidor" value={`${incident.server_name ?? '—'} (${server?.host ?? '—'})`} mono />
          <Row label="Entidade" value={incident.entity} mono />
          <Row label="Detecção" value={fmtDateTime(incident.first_seen)} mono />
          <Row label="Última confirmação" value={fmtDateTime(incident.last_seen)} mono />
          {incident.triggered_by && (
            <Row label="Regra" value={`${incident.triggered_by.rule} · limite ${String(incident.triggered_by.threshold)} · observado ${String(incident.triggered_by.observed)}`} mono />
          )}
          {incident.unverified_since && (
            <div style={{
              marginTop: 4, padding: '8px 10px', borderRadius: 8, fontSize: 11.5, lineHeight: 1.45,
              background: 'var(--surface)', border: '1px dashed var(--border)', color: 'var(--muted)',
            }}>
              Não foi possível reverificar desde <strong style={{ color: 'var(--text)' }}>{fmtDateTime(incident.unverified_since)}</strong>.
            </div>
          )}
        </div>

        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>Impacto estimado</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <ImpactBox label="Mensagens afetadas" field={incident.impact?.messages_affected} />
            <div style={{ background: 'var(--surface)', borderRadius: 9, padding: '12px 14px' }}>
              <div style={boxLabelStyle}>Tempo em aberto</div>
              <div style={boxValueStyle}>{fmtDuration(incident.impact?.total_open_seconds)}</div>
            </div>
            <ImpactBox
              label="Queda na entrega"
              field={incident.impact?.delivery_rate_impact_pct}
              format={v => (v > 0 ? `-${v} p.p.` : 'sem queda')}
            />
            {incident.impact?.cost_estimate && (
              <div style={{ background: 'var(--warn-bg)', border: '1px solid var(--warn-border)', borderRadius: 9, padding: '12px 14px', gridColumn: 'span 2' }}>
                <div style={{ fontSize: 11.5, color: 'var(--warn)', fontWeight: 700 }}>
                  Custo estimado: R$ {incident.impact.cost_estimate.total_brl.toFixed(2)}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--warn)', opacity: 0.85, marginTop: 2 }}>
                  {incident.impact.cost_estimate.basis}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Stepper (estado real) ── */}
      <Stepper status={incident.status} />

      {/* ── Correção sugerida — a "checklist" honesta: uma ação, plan()→apply() ── */}
      <div style={{ background: 'var(--card)', border: '1.5px solid var(--warn-border)', borderRadius: 12, padding: '20px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>Correção sugerida</span>
          <span style={{
            fontSize: 11, fontWeight: 600, borderRadius: 999, padding: '2px 9px',
            background: isResolved || incident.status === 'mitigado' ? 'var(--ok-bg)' : 'var(--warn-bg)',
            border: `1px solid ${isResolved || incident.status === 'mitigado' ? 'var(--ok-border)' : 'var(--warn-border)'}`,
            color: isResolved || incident.status === 'mitigado' ? 'var(--ok)' : 'var(--warn)',
          }}>
            {isResolved || incident.status === 'mitigado' ? 'Concluída' : fixAction ? 'Pendente' : 'Manual'}
          </span>
        </div>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 12, whiteSpace: 'pre-wrap' }}>
          {incident.suggested_fix?.description ?? 'Sem orientação registrada.'}
        </p>
        {!fixAction ? (
          <p style={{ fontSize: 11, color: 'var(--dim)' }}>Correção manual — sem ação executável de um clique para este caso.</p>
        ) : isResolved || incident.status === 'mitigado' ? null : observationReason ? (
          <div style={{ borderRadius: 10, padding: '10px 12px', fontSize: 11.5, lineHeight: 1.5, background: 'var(--warn-bg)', border: '1px solid var(--warn-border)', color: 'var(--warn)' }}>
            {observationReason}
          </div>
        ) : !plan ? (
          <Button size="sm" onClick={requestPlan} disabled={planning}>
            {planning ? 'Gerando preview…' : 'Aplicar correção sugerida'}
          </Button>
        ) : (
          <div style={{ borderRadius: 10, padding: '12px 14px', background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <AlertTriangle size={13} color="var(--danger)" />
              <span style={{ fontSize: 12, color: 'var(--danger)', fontWeight: 600 }}>Preview — nada foi alterado ainda</span>
            </div>
            <div style={{ marginBottom: 8, fontSize: 11.5, color: 'var(--text)', background: 'var(--card)', border: '1px solid var(--danger-border)', borderRadius: 7, padding: '8px 10px', whiteSpace: 'pre-wrap' }}>
              {plan.preview?.message || 'Plano gerado.'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10 }}>
              <strong>Como reverter:</strong> {plan.revert_description}
            </div>
            <div className="flex gap-2">
              <Button variant="destructive" size="sm" onClick={applyFix} disabled={applying}>
                {applying ? 'Aplicando…' : applyLabel(fixAction.action)}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setPlan(null)} disabled={applying}>Cancelar</Button>
            </div>
          </div>
        )}
      </div>

      {/* ── Responsáveis + Timeline ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }} className="plano-2col">
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>Quem agiu</div>
          {actors.length === 0 ? (
            <p style={{ fontSize: 12, color: 'var(--dim)' }}>Nenhuma ação humana registrada ainda — só o motor de detecção.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {actors.map(actor => {
                const last = [...events].reverse().find(e => e.actor === actor)
                return (
                  <div key={actor} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--text)', color: 'var(--card)', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {initials(actor)}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{actor}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{EVENT_LABELS[last?.event_type] ?? last?.event_type} · {fmtAge(last?.at)}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>Timeline</div>
          {events.map((e, i) => (
            <div key={i} style={{ display: 'flex', gap: 16, alignItems: 'flex-start', padding: '8px 0', borderBottom: i < events.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, color: 'var(--ok)', fontWeight: 600, whiteSpace: 'nowrap', width: 44 }}>
                {fmtTime(e.at)}
              </span>
              <span style={{ fontSize: 12.5, color: 'var(--text)' }}>
                {EVENT_LABELS[e.event_type] ?? e.event_type}
                {e.actor && e.actor !== 'system' && <span style={{ color: 'var(--muted)' }}> · {e.actor}</span>}
              </span>
            </div>
          ))}
        </div>
      </div>

      <style>{`@media (max-width: 900px) { .plano-2col { grid-template-columns: 1fr !important; } }`}</style>
    </div>
  )
}

const boxLabelStyle = { fontSize: 10.5, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, fontWeight: 600 }
const boxValueStyle = { fontFamily: "'JetBrains Mono', monospace", fontSize: 20, fontWeight: 700, color: 'var(--text)' }

function ImpactBox({ label, field, format = String }) {
  if (!field) return null
  if (!field.estimable) {
    return (
      <div style={{ background: 'var(--surface)', borderRadius: 9, padding: '12px 14px', gridColumn: 'span 2' }}>
        <div style={boxLabelStyle}>{label}</div>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>não estimável</div>
        <div style={{ fontSize: 10, color: 'var(--dim)', marginTop: 2 }}>{field.reason}</div>
      </div>
    )
  }
  return (
    <div style={{ background: 'var(--surface)', borderRadius: 9, padding: '12px 14px' }}>
      <div style={boxLabelStyle}>{label}</div>
      <div style={boxValueStyle}>{format(field.value)}</div>
    </div>
  )
}

function Row({ label, value, mono = false }) {
  if (!value) return null
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <span style={{ fontSize: 12, color: 'var(--dim)', width: 130, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', fontFamily: mono ? "'JetBrains Mono', monospace" : undefined }}>{value}</span>
    </div>
  )
}
