/**
 * Sessão 2, Tarefa 6 — lista da Triagem. Cross-fleet por padrão (todos
 * os servidores juntos, nome do servidor visível em cada item) — nunca
 * filtra por servidor implicitamente, é o oposto do resto do painel
 * (que gira em torno de `activeServer`).
 */
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SEVERITY_STYLE, STATUS_LABELS, STATUS_STYLE, TYPE_LABELS, fmtAge } from './incidentLabels'

// "open" é um pseudo-status (qualquer um dos 3 estados ativos) — a API
// só filtra por um status exato de cada vez, então TriagePage resolve
// "open" buscando sem filtro de status e filtrando no cliente.
const STATUS_FILTERS = [
  { value: 'open', label: 'Ativos (aberto/observação/mitigado)' },
  { value: 'aberto', label: 'Aberto' },
  { value: 'em_observacao', label: 'Em observação' },
  { value: 'mitigado', label: 'Mitigado' },
  { value: 'resolvido', label: 'Resolvido' },
  { value: 'all', label: 'Todos' },
]

const SEVERITY_FILTERS = [
  { value: 'all', label: 'Qualquer severidade' },
  { value: 'critico', label: 'Crítico' },
  { value: 'atencao', label: 'Atenção' },
]

function Row({ incident, selected, onSelect }) {
  const sev = SEVERITY_STYLE[incident.severity] ?? SEVERITY_STYLE.atencao
  const st  = STATUS_STYLE[incident.status] ?? STATUS_STYLE.aberto

  return (
    <button
      onClick={() => onSelect(incident.id)}
      data-incident-row={incident.id}
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        padding: '10px 12px', borderRadius: 9, marginBottom: 4,
        border: `1px solid ${selected ? 'var(--sky)' : 'var(--border)'}`,
        background: selected ? 'var(--accent-bg)' : 'var(--card)',
        cursor: 'pointer', transition: 'background 0.1s, border-color 0.1s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: sev.text, flexShrink: 0 }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)', fontFamily: 'monospace' }}>
          {incident.display_id}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--dim)' }}>{fmtAge(incident.last_seen)}</span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text)', marginBottom: 5, fontWeight: 500 }}>
        {TYPE_LABELS[incident.type] ?? incident.type}
        <span style={{ color: 'var(--dim)', fontWeight: 400 }}> — {incident.entity}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 9.5, fontWeight: 600, padding: '1px 7px', borderRadius: 999,
          border: `1px solid ${st.border}`, background: st.bg, color: st.text,
        }}>
          {STATUS_LABELS[incident.status] ?? incident.status}
        </span>
        <span style={{ fontSize: 10.5, color: 'var(--dim)', fontWeight: 600 }}>
          {incident.server_name ?? `servidor #${incident.server_id}`}
        </span>
      </div>
    </button>
  )
}

export default function IncidentList({
  incidents, selectedId, onSelect, status, onStatusChange, severity, onSeverityChange, loading,
}) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
      overflow: 'hidden',
    }}>
      <div style={{ padding: 10, borderBottom: '1px solid var(--border)', display: 'flex', gap: 6, flexShrink: 0 }}>
        <Select value={status} onValueChange={onStatusChange}>
          <SelectTrigger style={{ height: 28, fontSize: 11, flex: 1 }}><SelectValue /></SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map(f => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={severity} onValueChange={onSeverityChange}>
          <SelectTrigger style={{ height: 28, fontSize: 11, width: 130 }}><SelectValue /></SelectTrigger>
          <SelectContent>
            {SEVERITY_FILTERS.map(f => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
        {loading ? (
          <p style={{ fontSize: 12, color: 'var(--dim)', padding: 8 }}>Carregando…</p>
        ) : incidents.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--dim)', padding: 8 }}>Nenhum incidente neste filtro.</p>
        ) : (
          incidents.map(inc => (
            <Row key={inc.id} incident={inc} selected={inc.id === selectedId} onSelect={onSelect} />
          ))
        )}
      </div>

      <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', fontSize: 10, color: 'var(--dim)', flexShrink: 0 }}>
        <kbd style={{ fontFamily: 'monospace' }}>J</kbd>/<kbd style={{ fontFamily: 'monospace' }}>K</kbd> navegar ·{' '}
        <kbd style={{ fontFamily: 'monospace' }}>E</kbd> resolver ·{' '}
        <kbd style={{ fontFamily: 'monospace' }}>S</kbd> silenciar
      </div>
    </div>
  )
}
