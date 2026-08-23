/**
 * Lista da Triagem.
 *
 * Sessão 4:
 *   T4 — incidentes distintos sobre a MESMA entidade e o mesmo servidor
 *        aparecem agrupados, não como itens irmãos sem relação. Era o
 *        caso do INC-58 e do INC-59: o mesmo endereço IP, dois
 *        incidentes críticos lado a lado sem nada indicando que falavam
 *        do mesmo lugar.
 *   T11 — o título diz o fato ("IP x listado na Spamhaus ZEN"), não a
 *        chave interna; os filtros ganharam rótulo e largura suficiente
 *        (estavam truncados em "Ativos..." e "Qualque..."); a lista
 *        mostra a IDADE do incidente, com a última ocorrência como
 *        informação secundária — antes as duas se confundiam, e a lista
 *        dizia "1min" enquanto o detalhe dizia "2h34min" para o mesmo item.
 */
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  SEVERITY_STYLE, STATUS_LABELS, STATUS_STYLE, entityValue, fmtAge, incidentTitle,
} from './incidentLabels'

// "Ativos" é um pseudo-status (qualquer um dos 3 estados ativos) — a API
// filtra por um status exato de cada vez, então a Triagem resolve isso
// buscando sem filtro e filtrando no cliente.
const STATUS_FILTERS = [
  { value: 'open', label: 'Ativos' },
  { value: 'aberto', label: 'Aberto' },
  { value: 'em_observacao', label: 'Em observação' },
  { value: 'mitigado', label: 'Mitigado' },
  { value: 'resolvido', label: 'Resolvido' },
  { value: 'all', label: 'Todos' },
]

const SEVERITY_FILTERS = [
  { value: 'all', label: 'Todas' },
  { value: 'critico', label: 'Crítico' },
  { value: 'atencao', label: 'Atenção' },
]

function Row({ incident, selected, onSelect, showServerName, grouped }) {
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
        marginLeft: grouped ? 10 : 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: sev.text, flexShrink: 0 }} />
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)', fontFamily: 'monospace' }}>
          {incident.display_id}
        </span>
        {/* Idade do incidente — desde quando existe. A última ocorrência
            fica no detalhe; misturar as duas na mesma posição foi o que
            fazia a lista e o detalhe parecerem discordar. */}
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--dim)' }}
              title="Há quanto tempo este incidente existe">
          há {fmtAge(incident.first_seen)}
        </span>
      </div>

      <div style={{ fontSize: 12, color: 'var(--text)', marginBottom: 5, fontWeight: 500, lineHeight: 1.35 }}>
        {incidentTitle(incident)}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 9.5, fontWeight: 600, padding: '1px 7px', borderRadius: 999,
          border: `1px solid ${st.border}`, background: st.bg, color: st.text,
        }}>
          {STATUS_LABELS[incident.status] ?? incident.status}
        </span>
        {incident.unverified_since && (
          <span style={{
            fontSize: 9.5, fontWeight: 600, padding: '1px 7px', borderRadius: 999,
            border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--dim)',
          }} title="A verificação que sustenta este incidente parou de responder">
            não reverificado
          </span>
        )}
        {showServerName && (
          <span style={{ fontSize: 10.5, color: 'var(--dim)', fontWeight: 600 }}>
            {incident.server_name ?? `servidor #${incident.server_id}`}
          </span>
        )}
      </div>
    </button>
  )
}

// Agrupa por servidor + entidade normalizada (T4). Um grupo só vira
// cabeçalho quando de fato tem mais de um incidente — um item sozinho
// não ganha moldura à toa.
function groupIncidents(incidents) {
  const groups = []
  const byKey = new Map()
  for (const inc of incidents) {
    const key = `${inc.server_id}|${inc.entity}`
    if (!byKey.has(key)) {
      const group = { key, entity: inc.entity, serverName: inc.server_name, serverId: inc.server_id, items: [] }
      byKey.set(key, group)
      groups.push(group)
    }
    byKey.get(key).items.push(inc)
  }
  return groups
}

export default function IncidentList({
  incidents, selectedId, onSelect, status, onStatusChange, severity, onSeverityChange,
  loading, showServerName = true,
}) {
  const groups = groupIncidents(incidents)

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12,
      overflow: 'hidden',
    }}>
      <div style={{
        padding: 10, borderBottom: '1px solid var(--border)',
        display: 'flex', gap: 10, flexShrink: 0,
      }}>
        <label style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 9.5, color: 'var(--dim)', marginBottom: 3,
                         textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
            Status
          </span>
          <Select value={status} onValueChange={onStatusChange}>
            <SelectTrigger style={{ height: 28, fontSize: 11, width: '100%' }}><SelectValue /></SelectTrigger>
            <SelectContent>
              {STATUS_FILTERS.map(f => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
        <label style={{ width: 118, flexShrink: 0 }}>
          <span style={{ display: 'block', fontSize: 9.5, color: 'var(--dim)', marginBottom: 3,
                         textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
            Severidade
          </span>
          <Select value={severity} onValueChange={onSeverityChange}>
            <SelectTrigger style={{ height: 28, fontSize: 11, width: '100%' }}><SelectValue /></SelectTrigger>
            <SelectContent>
              {SEVERITY_FILTERS.map(f => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </label>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 8 }}>
        {loading && incidents.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--dim)', padding: 8 }}>Carregando…</p>
        ) : incidents.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--dim)', padding: 8 }}>Nenhum incidente neste filtro.</p>
        ) : (
          groups.map(group => (
            <div key={group.key} style={{ marginBottom: group.items.length > 1 ? 8 : 0 }}>
              {group.items.length > 1 && (
                <div style={{
                  fontSize: 10, color: 'var(--muted)', padding: '4px 4px 5px',
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <span style={{ fontWeight: 700, color: 'var(--text)' }}>{entityValue(group.entity)}</span>
                  <span>· {group.items.length} incidentes no mesmo endereço</span>
                  {showServerName && <span style={{ marginLeft: 'auto' }}>{group.serverName}</span>}
                </div>
              )}
              {group.items.map(inc => (
                <Row
                  key={inc.id} incident={inc} selected={inc.id === selectedId} onSelect={onSelect}
                  showServerName={showServerName && group.items.length === 1}
                  grouped={group.items.length > 1}
                />
              ))}
            </div>
          ))
        )}
      </div>

      {/* T11: o atalho é uma indicação discreta no rodapé, não parte do
          rótulo de nenhum botão. */}
      <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', fontSize: 10, color: 'var(--dim)', flexShrink: 0 }}>
        <kbd style={{ fontFamily: 'monospace' }}>J</kbd>/<kbd style={{ fontFamily: 'monospace' }}>K</kbd> navegar ·{' '}
        <kbd style={{ fontFamily: 'monospace' }}>E</kbd> resolver ·{' '}
        <kbd style={{ fontFamily: 'monospace' }}>S</kbd> silenciar
      </div>
    </div>
  )
}
