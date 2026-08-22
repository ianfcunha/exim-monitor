/**
 * Sessão 2, Tarefa 6 — coluna de detalhe da Triagem: métricas do
 * incidente, correção sugerida (com preview antes de aplicar) e
 * "mensagens afetadas". O painel de evidência é um componente irmão
 * (EvidencePanel), não parte deste — fica sempre visível ao lado, não
 * dentro de uma aba daqui.
 *
 * "Aplicar correção sugerida" segue o mesmo fluxo plan()→preview→apply()
 * já validado em ActionPanel/MaintenancePage (Sessão 1, T3): nada
 * executa até o usuário ver exatamente o que vai mudar.
 */
import { AlertTriangle, Check, CheckCircle2, FileText, Settings2, ShieldOff } from 'lucide-react'
import { useState } from 'react'
import { ackIncident, applyIncidentFix, fetchIncidentReportHtml, planIncidentFix, resolveIncident, silenceIncident } from '../../api/client'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SEVERITY_STYLE, STATUS_LABELS, STATUS_STYLE, TYPE_LABELS, applyLabel } from './incidentLabels'
import ThresholdEditor from './ThresholdEditor'
import { useToast } from '../../contexts/ToastContext'

function fmtDateTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('pt-BR')
}

function Stat({ label, value }) {
  return (
    <div style={{
      padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)',
      minWidth: 0,
    }}>
      <div style={{ fontSize: 9.5, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {value}
      </div>
    </div>
  )
}

// Chaves de metrics que valem a pena virar um número de destaque — o
// resto (arrays, objetos aninhados) fica só implícito na descrição do
// suggested_fix, não teria uma forma boa de Stat card.
const METRIC_LABELS = {
  distinct_ips: 'IPs distintos', volume: 'Volume', baseline: 'Baseline',
  blocklists_listed: 'Blocklists', missing: 'Faltando (SPF/DKIM/DMARC)',
  days_remaining: 'Dias p/ cert expirar', queue_total: 'Fila total',
  baseline_floor: 'Piso do baseline', frozen_count: 'Frozen', floor: 'Piso',
  deferred_count: 'Deferidos', share_of_total: 'Fração do total', total_deferred: 'Total deferido',
  ip: 'IP', domain: 'Domínio', cert_valid: 'Certificado válido',
}

function MetricsGrid({ metrics }) {
  const entries = Object.entries(metrics || {}).filter(([, v]) => v !== null && typeof v !== 'object')
  if (entries.length === 0) return null
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8 }}>
      {entries.map(([k, v]) => (
        <Stat key={k} label={METRIC_LABELS[k] ?? k} value={typeof v === 'boolean' ? (v ? 'sim' : 'não') : String(v)} />
      ))}
    </div>
  )
}

// Sessão 3, Tarefa 1 — "o número que o dono do host entende". Vem de
// incident.impact (backend/app/incident_impact.py): calculado ao vivo
// enquanto o incidente está aberto, congelado no fechamento.
function fmtDuration(seconds) {
  if (seconds == null) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  if (h === 0) return `${m}min`
  return `${h}h${m > 0 ? ` ${m}min` : ''}`
}

function ImpactSection({ impact }) {
  if (!impact) return null
  const entities = [...(impact.accounts_affected || []), ...(impact.domains_affected || [])]
  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        Impacto
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8, marginBottom: entities.length ? 8 : 0 }}>
        <Stat label="Mensagens afetadas" value={impact.messages_affected} />
        {impact.stuck_over_4h > 0 && <Stat label="Presas há +4h" value={impact.stuck_over_4h} />}
        <Stat label="Tempo em aberto" value={fmtDuration(impact.total_open_seconds)} />
        <Stat
          label="Impacto na entrega"
          value={impact.delivery_rate_impact_pct == null ? 'sem baseline' : `${impact.delivery_rate_impact_pct > 0 ? '-' : '+'}${Math.abs(impact.delivery_rate_impact_pct)} p.p.`}
        />
      </div>
      {entities.length > 0 && (
        <p style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: impact.cost_estimate ? 8 : 0 }}>
          Contas/domínios de cliente afetados: <strong style={{ color: 'var(--text)' }}>{entities.join(', ')}</strong>
        </p>
      )}
      {impact.cost_estimate && (
        <div style={{
          fontSize: 11.5, padding: '8px 10px', borderRadius: 8,
          background: 'var(--warn-bg)', border: '1px solid var(--warn-border)', color: 'var(--warn)',
        }}>
          <strong>Custo estimado: R$ {impact.cost_estimate.total_brl.toFixed(2)}</strong> ({impact.cost_estimate.label})
          <div style={{ fontSize: 10.5, opacity: 0.85, marginTop: 2 }}>{impact.cost_estimate.basis}</div>
        </div>
      )}
    </div>
  )
}

export default function IncidentDetail({ incident, onChanged }) {
  const toast = useToast()
  const [busy, setBusy]           = useState(null) // 'ack' | 'silence' | 'resolve' | null
  const [plan, setPlan]           = useState(null)
  const [planning, setPlanning]   = useState(false)
  const [applying, setApplying]   = useState(false)
  const [thresholdsOpen, setThresholdsOpen] = useState(false)
  const [reportLoading, setReportLoading] = useState(false)

  if (!incident) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%',
        color: 'var(--dim)', fontSize: 13, border: '1px solid var(--border)', borderRadius: 12,
        background: 'var(--card)',
      }}>
        Selecione um incidente na lista à esquerda.
      </div>
    )
  }

  const sev = SEVERITY_STYLE[incident.severity] ?? SEVERITY_STYLE.atencao
  const st  = STATUS_STYLE[incident.status] ?? STATUS_STYLE.aberto
  const fixAction = incident.suggested_fix?.action
  const isResolved = incident.status === 'resolvido'

  const requestPlan = async () => {
    setPlanning(true)
    try {
      const res = await planIncidentFix(incident.id)
      setPlan(res)
    } catch (err) {
      toast({ type: 'err', msg: err?.response?.data?.detail || err.message || 'Erro ao planejar correção.' })
    } finally {
      setPlanning(false)
    }
  }

  const applyFix = async () => {
    if (!plan) return
    setApplying(true)
    try {
      const res = await applyIncidentFix(incident.id, plan.plan_id)
      toast({ type: 'ok', msg: res.message || 'Correção aplicada.' })
      setPlan(null)
      onChanged?.()
    } catch (err) {
      toast({ type: 'err', msg: err?.response?.data?.detail || err.message || 'Erro ao aplicar correção.' })
    } finally {
      setApplying(false)
    }
  }

  // Sessão 3, T2 — busca o HTML como blob (a rota exige o mesmo Bearer
  // token de toda a API, então uma navegação direta <a href> quebraria)
  // e abre numa aba nova; de lá o próprio usuário usa Ctrl+P/"Salvar
  // como" do navegador pra imprimir ou gerar o arquivo autocontido que
  // encaminha ao cliente dele.
  const openReport = async () => {
    setReportLoading(true)
    try {
      const res = await fetchIncidentReportHtml(incident.id)
      const url = window.URL.createObjectURL(res.data)
      window.open(url, '_blank')
      setTimeout(() => window.URL.revokeObjectURL(url), 60_000)
    } catch (err) {
      toast({ type: 'err', msg: err?.response?.data?.detail || err.message || 'Erro ao gerar relatório.' })
    } finally {
      setReportLoading(false)
    }
  }

  const doAck = async () => {
    setBusy('ack')
    try { await ackIncident(incident.id); onChanged?.() }
    catch (err) { toast({ type: 'err', msg: err?.response?.data?.detail || 'Erro ao confirmar ciência.' }) }
    finally { setBusy(null) }
  }

  const doSilence = async () => {
    setBusy('silence')
    try {
      await silenceIncident(incident.id, 60)
      toast({ type: 'ok', msg: 'Silenciado por 60 minutos.' })
      onChanged?.()
    } catch (err) { toast({ type: 'err', msg: err?.response?.data?.detail || 'Erro ao silenciar.' }) }
    finally { setBusy(null) }
  }

  const doResolve = async () => {
    setBusy('resolve')
    try {
      await resolveIncident(incident.id, 'manual')
      toast({ type: 'ok', msg: 'Incidente resolvido.' })
      onChanged?.()
    } catch (err) { toast({ type: 'err', msg: err?.response?.data?.detail || 'Erro ao resolver.' }) }
    finally { setBusy(null) }
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 14, height: '100%', overflow: 'auto',
      background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: 16,
    }}>
      {/* ── Cabeçalho ── */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)', fontFamily: 'monospace' }}>
            {incident.display_id}
          </span>
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
            border: `1px solid ${sev.border}`, background: sev.bg, color: sev.text, textTransform: 'uppercase',
          }}>
            {incident.severity}
          </span>
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
            border: `1px solid ${st.border}`, background: st.bg, color: st.text,
          }}>
            {STATUS_LABELS[incident.status] ?? incident.status}
          </span>
        </div>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>
          {TYPE_LABELS[incident.type] ?? incident.type} — <span style={{ fontWeight: 500 }}>{incident.entity}</span>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>
            {incident.server_name ?? `servidor #${incident.server_id}`} · desde {fmtDateTime(incident.first_seen)}
            {' · '}última vez {fmtDateTime(incident.last_seen)}
          </span>
          {/* Sessão 3, T2 — o documento que o dono do host encaminha ao cliente dele */}
          <button
            onClick={openReport} disabled={reportLoading}
            style={{
              fontSize: 11, color: 'var(--sky)', fontWeight: 600, background: 'none', border: 'none',
              padding: 0, cursor: reportLoading ? 'default' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4,
            }}
          >
            <FileText size={11} /> {reportLoading ? 'Gerando relatório…' : 'Ver relatório →'}
          </button>
        </div>
      </div>

      {/* ── Ações de estado ── */}
      {!isResolved && (
        <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
          <Button size="sm" variant="outline" onClick={doAck} disabled={!!busy}>
            <Check size={12} /> {busy === 'ack' ? 'Confirmando…' : 'Confirmar ciência'}
          </Button>
          <Button size="sm" variant="outline" onClick={doSilence} disabled={!!busy}>
            <ShieldOff size={12} /> {busy === 'silence' ? 'Silenciando…' : 'Silenciar (60min) — S'}
          </Button>
          <Button size="sm" variant="outline" onClick={doResolve} disabled={!!busy}>
            <CheckCircle2 size={12} /> {busy === 'resolve' ? 'Resolvendo…' : 'Resolver — E'}
          </Button>
        </div>
      )}

      {/* ── Por que isto virou incidente ── */}
      {incident.triggered_by && (
        <div style={{
          fontSize: 11.5, color: 'var(--muted)', padding: '8px 10px', borderRadius: 8,
          background: 'var(--surface)', border: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap',
        }}>
          <span>
            Por que isto virou incidente: regra <strong style={{ fontFamily: 'monospace', color: 'var(--text)' }}>{incident.triggered_by.rule}</strong>,
            limite <strong>{String(incident.triggered_by.threshold)}</strong>, observado <strong>{String(incident.triggered_by.observed)}</strong>.
          </span>
          <Popover open={thresholdsOpen} onOpenChange={setThresholdsOpen}>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline"><Settings2 size={11} /> Ajustar limite</Button>
            </PopoverTrigger>
            <PopoverContent align="end">
              <ThresholdEditor serverId={incident.server_id} type={incident.type} onClose={() => setThresholdsOpen(false)} />
            </PopoverContent>
          </Popover>
        </div>
      )}

      {/* ── Métricas ── */}
      <MetricsGrid metrics={incident.metrics} />

      {/* ── Impacto (Sessão 3, T1) ── */}
      <ImpactSection impact={incident.impact} />

      {/* ── Correção sugerida ── */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          Correção sugerida
        </div>
        <p style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 10, whiteSpace: 'pre-wrap' }}>
          {incident.suggested_fix?.description ?? 'Sem orientação registrada.'}
        </p>

        {!fixAction ? (
          <p style={{ fontSize: 11, color: 'var(--dim)' }}>
            Esta correção é manual — não há uma ação executável de um clique para este caso.
          </p>
        ) : isResolved ? null : !plan ? (
          <Button size="sm" onClick={requestPlan} disabled={planning}>
            {planning ? 'Gerando preview…' : 'Aplicar correção sugerida'}
          </Button>
        ) : (
          <div style={{
            borderRadius: 10, padding: '12px 14px',
            background: 'var(--danger-bg)', border: '1px solid var(--danger-border)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <AlertTriangle size={13} color="var(--danger)" />
              <span style={{ fontSize: 12, color: 'var(--danger)', fontWeight: 600 }}>Preview — nada foi alterado ainda</span>
            </div>
            <div style={{
              marginBottom: 8, fontSize: 11.5, color: 'var(--text)',
              background: 'var(--card)', border: '1px solid var(--danger-border)',
              borderRadius: 7, padding: '8px 10px', whiteSpace: 'pre-wrap',
            }}>
              {plan.preview?.message || 'Plano gerado.'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10 }}>
              <strong>Como reverter:</strong> {plan.revert_description}
            </div>
            <div className="flex gap-2">
              <Button
                variant="destructive" size="sm" onClick={applyFix} disabled={applying}
                className="border-transparent bg-red-600 text-white shadow-sm hover:bg-red-700 hover:text-white active:bg-red-800"
              >
                {applying ? 'Aplicando…' : applyLabel(fixAction.action)}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setPlan(null)} disabled={applying}>Cancelar</Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
