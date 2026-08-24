/**
 * Métricas — Sessão 6, handoff Mail IQ 2.0.
 *
 * Volume de fila e taxa de entrega nas últimas horas, com KPIs de
 * resumo. Fonte: GET /api/history (Snapshot — mesma série que
 * HistoryChart.jsx, no "modo avançado" do painel clássico), agora numa
 * tela própria, com os cartões de resumo do handoff.
 *
 * O mockup mostra "toda a frota" numa linha só; a série real é POR
 * SERVIDOR (Snapshot.server_id) — somar servidores diferentes no mesmo
 * ponto do tempo sem agregação por timestamp seria um gráfico
 * enganoso. Segue o mesmo padrão já usado na Fila (Sessão 5): com mais
 * de um servidor cadastrado e nenhum selecionado, pede a escolha em vez
 * de inventar uma agregação.
 */
import { LayoutGrid } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { fetchHistory } from '../api/client'
import { Button } from '@/components/ui/button'
import { useServer } from '../contexts/ServerContext'

const PERIODS = [
  { key: '6h', hours: 6 }, { key: '24h', hours: 24 }, { key: '7d', hours: 168 },
]
const CRIT_SEVERITIES = new Set(['CRITICAL', 'HIGH', 'DEGRADED'])

function fmtTimeShort(iso, hours) {
  const d = new Date(iso)
  return hours > 24
    ? d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit' })
    : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

function ChooseServer({ servers, onPick }) {
  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '48px 24px', width: '100%' }}>
      <div style={{
        background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
        padding: '28px 24px', textAlign: 'center', maxWidth: 520, margin: '0 auto',
      }}>
        <LayoutGrid size={22} color="var(--dim)" style={{ marginBottom: 10 }} />
        <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: '0 0 6px' }}>
          Métricas são por servidor
        </p>
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 18px', lineHeight: 1.55 }}>
          Volume de fila e taxa de entrega são séries de um servidor específico —
          somar servidores diferentes no mesmo gráfico esconderia de qual é cada pico.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          {servers.map(s => (
            <Button key={s.id} size="sm" variant="outline" onClick={() => onPick(s)}>{s.name}</Button>
          ))}
        </div>
      </div>
    </div>
  )
}

function Kpi({ label, value, sub, color = 'var(--text)' }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px' }}>
      <div style={{ fontSize: 11, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, marginBottom: 5 }}>{label}</div>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 26, fontWeight: 700, color, letterSpacing: '-0.02em', lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--dim)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

function ChartCard({ title, sub, badge, children }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '22px 24px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{title}</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{sub}</span>
        {badge && (
          <span style={{
            marginLeft: 'auto', fontSize: 11.5, fontWeight: 600, color: 'var(--danger)',
            background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', borderRadius: 999, padding: '2px 9px',
          }}>
            {badge}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}

export default function MetricasPage() {
  const { activeServer, isFleet, servers, setActiveServer } = useServer()
  const [periodKey, setPeriodKey] = useState('24h')
  const [rows, setRows]     = useState([])
  const [loading, setLoading] = useState(true)

  const ambiguous = !activeServer && isFleet && servers.length > 1
  const hours = PERIODS.find(p => p.key === periodKey).hours

  // serverId null é válido aqui: com um servidor só cadastrado (frota
  // de 1), o backend resolve sozinho (_resolve_server_id) — só recusa
  // quando é genuinamente ambíguo, e nesse caso `ambiguous` já barrou
  // acima antes deste efeito rodar.
  useEffect(() => {
    if (ambiguous) { setLoading(false); return }
    setLoading(true)
    fetchHistory(hours, 'quick', activeServer?.id ?? null)
      .then(setRows).catch(() => setRows([])).finally(() => setLoading(false))
  }, [activeServer, hours, ambiguous])

  const { queuePts, delivPts, kpis } = useMemo(() => {
    if (rows.length === 0) return { queuePts: [], delivPts: [], kpis: null }
    const queuePts = rows.map(r => ({ time: fmtTimeShort(r.timestamp, hours), Fila: r.queue_total }))
    const delivPts = rows.map(r => {
      const total = (r.delivered ?? 0) + (r.rejected ?? 0) + (r.deferred ?? 0)
      return { time: fmtTimeShort(r.timestamp, hours), Entrega: total > 0 ? Math.round((r.delivered / total) * 1000) / 10 : null }
    })
    const peak = rows.reduce((m, r) => (r.queue_total > m.queue_total ? r : m), rows[0])
    const rates = delivPts.map(p => p.Entrega).filter(v => v != null)
    const avgRate = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null
    const avgQueue = rows.reduce((s, r) => s + r.queue_total, 0) / rows.length
    const critEvents = rows.filter(r => CRIT_SEVERITIES.has(r.severity)).length
    return {
      queuePts, delivPts,
      kpis: {
        peak: peak.queue_total, peakAt: fmtTimeShort(peak.timestamp, hours),
        avgRate, avgQueue, critEvents,
      },
    }
  }, [rows, hours])

  if (ambiguous) return <ChooseServer servers={servers} onPick={setActiveServer} />

  const scopeLabel = activeServer?.name ?? (servers[0]?.name ?? 'servidor')

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '20px 24px 32px', width: '100%', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text)' }}>
            Métricas · {scopeLabel}
          </h2>
          <p style={{ margin: '5px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            {rows.length} ponto{rows.length === 1 ? '' : 's'} de dados · coleta a cada 30s
          </p>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4, background: 'var(--surface-alt)', borderRadius: 9, padding: 3, border: '1px solid var(--border)' }}>
          {PERIODS.map(p => (
            <button
              key={p.key} onClick={() => setPeriodKey(p.key)}
              style={{
                padding: '5px 13px', borderRadius: 6, fontSize: 12.5, fontWeight: periodKey === p.key ? 600 : 500,
                background: periodKey === p.key ? 'var(--card)' : 'transparent',
                color: periodKey === p.key ? 'var(--sky)' : 'var(--muted)',
                border: 'none', cursor: 'pointer',
                boxShadow: periodKey === p.key ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              }}
            >
              {p.key}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--dim)', fontSize: 13 }}>Carregando…</div>
      ) : rows.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--dim)', textAlign: 'center', padding: '40px 0', fontStyle: 'italic' }}>
          Sem dados suficientes neste período — aguarde alguns ciclos de coleta.
        </p>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14 }} className="metricas-kpi">
            <Kpi label="Pico da fila" value={kpis.peak.toLocaleString('pt-BR')} sub={`às ${kpis.peakAt}`} color="var(--danger)" />
            <Kpi label="Entrega média" value={kpis.avgRate != null ? `${kpis.avgRate.toFixed(1).replace('.', ',')}%` : '—'} sub="meta 99%" color={kpis.avgRate != null && kpis.avgRate < 99 ? 'var(--warn)' : 'var(--ok)'} />
            <Kpi label="Eventos críticos" value={kpis.critEvents} sub={`de ${rows.length} coletas`} />
            <Kpi label="Fila média" value={Math.round(kpis.avgQueue).toLocaleString('pt-BR')} />
          </div>

          <ChartCard title="Volume da fila" sub={`mensagens acumuladas · ${periodKey}`} badge={`pico: ${kpis.peak.toLocaleString('pt-BR')}`}>
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={queuePts} margin={{ top: 4, right: 4, left: -14, bottom: 0 }}>
                <defs>
                  <linearGradient id="metricasQueueFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--sky)" stopOpacity={0.25} />
                    <stop offset="100%" stopColor="var(--sky)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="time" tick={{ fontSize: 10.5, fill: 'var(--dim)' }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} minTickGap={40} />
                <YAxis tick={{ fontSize: 10.5, fill: 'var(--dim)' }} axisLine={false} tickLine={false} width={40} />
                <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 11.5 }} labelStyle={{ color: 'var(--muted)' }} />
                <Area type="monotone" dataKey="Fila" stroke="var(--sky)" strokeWidth={2} fill="url(#metricasQueueFill)" />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Taxa de entrega" sub={`% de mensagens entregues · ${periodKey}`}>
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={delivPts} margin={{ top: 4, right: 4, left: -14, bottom: 0 }}>
                <defs>
                  <linearGradient id="metricasDelivFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--sky)" stopOpacity={0.25} />
                    <stop offset="100%" stopColor="var(--sky)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="time" tick={{ fontSize: 10.5, fill: 'var(--dim)' }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} minTickGap={40} />
                <YAxis domain={[80, 100]} tick={{ fontSize: 10.5, fill: 'var(--dim)' }} axisLine={false} tickLine={false} width={40} unit="%" />
                <Tooltip contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 11.5 }} labelStyle={{ color: 'var(--muted)' }} formatter={v => [`${v}%`, 'Entrega']} />
                <Area type="monotone" dataKey="Entrega" stroke="var(--sky)" strokeWidth={2} fill="url(#metricasDelivFill)" connectNulls />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>
        </>
      )}

      <style>{`@media (max-width: 900px) { .metricas-kpi { grid-template-columns: repeat(2,1fr) !important; } }`}</style>
    </div>
  )
}
