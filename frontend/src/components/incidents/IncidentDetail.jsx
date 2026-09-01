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
import { Check, CheckCircle2, FileText, Settings2, ShieldOff } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ackIncident, resolveIncident, silenceIncident } from '../../api/client'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SEVERITY_STYLE, STATUS_LABELS, STATUS_STYLE, incidentTitle, triggerExplanation } from './incidentLabels'
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
      <div
        title={String(value)}
        style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', overflowWrap: 'anywhere', lineHeight: 1.35 }}
      >
        {value}
      </div>
    </div>
  )
}

// Chaves de metrics que valem a pena virar um número de destaque — o
// resto (arrays, objetos aninhados) fica só implícito na descrição do
// suggested_fix, não teria uma forma boa de Stat card.
const METRIC_LABELS = {
  distinct_ips: 'IPs diferentes', volume: 'Volume', baseline: 'Volume normal',
  blocklists_listed: 'Blocklists', missing: 'Faltando (SPF/DKIM/DMARC)',
  days_remaining: 'Dias p/ o certificado vencer', queue_total: 'Mensagens na fila',
  baseline_floor: 'Limite p/ alertar', frozen_count: 'Mensagens congeladas', floor: 'Limite p/ alertar',
  deferred_count: 'Entregas adiadas', share_of_total: 'Fração adiada', total_deferred: 'Total adiado',
  ip: 'IP', domain: 'Domínio', cert_valid: 'Certificado válido',
  cause: 'O que está segurando', top_sender: 'Maior remetente', top_dest_domain: 'Maior destino',
  auth_count: 'Envios na janela',
}

// Valores que também são jargão, não só a chave.
const VALUE_LABELS = {
  cause: { destino: 'Destino recusando / atrasando', remetente: 'Concentrada num remetente', indeterminada: 'Sem padrão claro' },
}

function MetricsGrid({ metrics }) {
  const entries = Object.entries(metrics || {}).filter(([, v]) => v !== null && typeof v !== 'object')
  if (entries.length === 0) return null
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 8 }}>
      {entries.map(([k, v]) => {
        const raw = typeof v === 'boolean' ? (v ? 'sim' : 'não') : String(v)
        return <Stat key={k} label={METRIC_LABELS[k] ?? k} value={VALUE_LABELS[k]?.[raw] ?? raw} />
      })}
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

// Sessão 4, Tarefa 6 — impacto honesto. Todo valor vem do backend como
// {estimable: true, value, basis} ou {estimable: false, reason}. Um
// valor não estimável NÃO vira um número: vira "não estimável para este
// tipo de incidente" com o motivo em uma linha.
function ValueStat({ label, field, format = String }) {
  if (!field) return null
  if (!field.estimable) {
    return (
      <div style={{
        padding: '8px 10px', borderRadius: 8, border: '1px dashed var(--border)',
        background: 'var(--surface)', minWidth: 0, gridColumn: 'span 2',
      }}>
        <div style={{ fontSize: 9.5, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>
          {label}
        </div>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', marginBottom: 2 }}>
          não estimável para este tipo de incidente
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--dim)', lineHeight: 1.4 }}>{field.reason}</div>
      </div>
    )
  }
  return (
    <div style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', minWidth: 0 }}>
      <div style={{ fontSize: 9.5, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{format(field.value)}</div>
      {field.basis && (
        <div style={{ fontSize: 10, color: 'var(--dim)', marginTop: 3, lineHeight: 1.4 }}>{field.basis}</div>
      )}
    </div>
  )
}

function ReputationImpact({ detail }) {
  if (!detail) return null
  const top = detail.messages_to_top_destination
  return (
    <>
      <ValueStat label="Tempo listado" field={detail.listed_minutes} format={m => fmtDuration(m * 60)} />
      <ValueStat label="Zonas com listagem" field={detail.zones_listed}
                 format={z => Array.isArray(z) ? z.length : z} />
      <ValueStat label="Zonas consultadas" field={detail.zones_checked} />
      <ValueStat label="Maior volume para um destino" field={top}
                 format={v => `${v.count} para ${v.domain}`} />
    </>
  )
}

function ImpactSection({ impact }) {
  if (!impact) return null
  const entities = [...(impact.accounts_affected || []), ...(impact.domains_affected || [])]
  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        Impacto
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8, marginBottom: entities.length ? 8 : 0 }}>
        <ValueStat label="Mensagens afetadas" field={impact.messages_affected} />
        <div style={{ padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', minWidth: 0 }}>
          <div style={{ fontSize: 9.5, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>
            Tempo em aberto
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{fmtDuration(impact.total_open_seconds)}</div>
        </div>
        {impact.stuck_over_4h?.estimable && impact.stuck_over_4h.value > 0 && (
          <ValueStat label="Presas há mais de 4h" field={impact.stuck_over_4h} />
        )}
        {/* Nunca uma variação positiva como "impacto" de um incidente
            crítico: 0 significa "não houve queda", e o motivo fica no
            texto de base logo abaixo do número. */}
        <ValueStat
          label="Queda na taxa de entrega"
          field={impact.delivery_rate_impact_pct}
          format={v => (v > 0 ? `-${v} p.p.` : 'sem queda')}
        />
        <ReputationImpact detail={impact.reputation} />
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
  const [thresholdsOpen, setThresholdsOpen] = useState(false)

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
            {sev.label ?? incident.severity}
          </span>
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
            border: `1px solid ${st.border}`, background: st.bg, color: st.text,
          }}>
            {STATUS_LABELS[incident.status] ?? incident.status}
          </span>
        </div>
        {/* T11: o título diz o fato, não a chave interna. */}
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', marginBottom: 4, lineHeight: 1.3 }}>
          {incidentTitle(incident)}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span>
            {incident.server_name ?? `servidor #${incident.server_id}`} · aberto em {fmtDateTime(incident.first_seen)}
            {' · '}confirmado pela última vez em {fmtDateTime(incident.last_seen)}
          </span>
          {/* T9: rota real, com endereço permanente e link copiável — no
              lugar do blob: em aba nova, que não dava para voltar nem
              compartilhar. */}
          <Link
            to={`/incidents/${incident.id}/report`}
            style={{ fontSize: 11, color: 'var(--sky)', fontWeight: 600, textDecoration: 'none',
                     display: 'inline-flex', alignItems: 'center', gap: 4 }}
          >
            <FileText size={11} /> Ver relatório →
          </Link>
        </div>

        {/* T1: um incidente cuja verificação parou de responder não pode
            seguir afirmando que está confirmado agora. */}
        {incident.unverified_since && (
          <div style={{
            marginTop: 8, padding: '8px 10px', borderRadius: 8, fontSize: 11.5, lineHeight: 1.45,
            background: 'var(--surface)', border: '1px dashed var(--border)', color: 'var(--muted)',
          }}>
            Não foi possível reverificar este incidente desde{' '}
            <strong style={{ color: 'var(--text)' }}>{fmtDateTime(incident.unverified_since)}</strong> —
            ele continua aberto porque não há como confirmar que terminou, não porque foi confirmado de novo.
          </div>
        )}
      </div>

      {/* ── Ações de estado ── */}
      {!isResolved && (
        <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
          <Button size="sm" variant="outline" onClick={doAck} disabled={!!busy}>
            <Check size={12} /> {busy === 'ack' ? 'Confirmando…' : 'Confirmar ciência'}
          </Button>
          <Button size="sm" variant="outline" onClick={doSilence} disabled={!!busy}>
            <ShieldOff size={12} /> {busy === 'silence' ? 'Silenciando…' : 'Silenciar por 60min'}
          </Button>
          <Button size="sm" variant="outline" onClick={doResolve} disabled={!!busy}>
            <CheckCircle2 size={12} /> {busy === 'resolve' ? 'Resolvendo…' : 'Resolver'}
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
            <strong style={{ color: 'var(--text)' }}>Por que isto virou incidente:</strong>{' '}
            {triggerExplanation(incident)}
          </span>
          <Popover open={thresholdsOpen} onOpenChange={setThresholdsOpen}>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline"><Settings2 size={11} /> Ajustar quando alertar</Button>
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
        ) : isResolved ? null : (
          // A Triagem só orienta — aplicar a correção acontece no Plano
          // de correção, que reúne todas as ações disponíveis para o
          // incidente (não só a sugerida) com seleção explícita antes de
          // executar. Nenhuma ação que altera o servidor roda a partir
          // daqui.
          <Link to={`/plano/${incident.id}`} style={{ textDecoration: 'none' }}>
            <Button size="sm">
              Ver no Plano de correção →
            </Button>
          </Link>
        )}
      </div>
    </div>
  )
}
