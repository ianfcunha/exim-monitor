/**
 * HourlyBarChart — Tráfego por hora via hourly_stats.
 * Identidade AVILI light.
 */
import {
  Bar, BarChart, CartesianGrid, Legend,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'

const C = {
  Recebidas: '#22C55E',
  Entregues: 'var(--sky)',
}

const tooltipStyle = {
  contentStyle: {
    background: 'var(--card)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
  },
  labelStyle: { color: 'var(--muted)', fontSize: 11, marginBottom: 4 },
  itemStyle: { fontSize: 11, color: 'var(--text)' },
  cursor: { fill: 'rgba(14,165,233,0.04)' },
}

export default function HourlyBarChart({ data = [], loading = false }) {
  if (loading) {
    return (
      <div className="card space-y-3">
        <span className="section-label">Tráfego por hora</span>
        <div className="rounded-xl animate-pulse" style={{ height: 160, background: 'var(--surface)' }} />
      </div>
    )
  }

  if (!data.length) return null

  const chartData = data.map((d) => ({
    hour:      d.hour,
    Recebidas: d.recv ?? 0,
    Entregues: d.sent ?? 0,
  }))

  const totalRecv = data.reduce((s, d) => s + (d.recv ?? 0), 0)
  const totalSent = data.reduce((s, d) => s + (d.sent ?? 0), 0)

  return (
    <div className="card space-y-3">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <span className="section-label">Tráfego por hora</span>
        <div style={{ display: 'flex', gap: 12, fontSize: 11 }}>
          <span style={{ color: C.Recebidas, fontWeight: 600 }}>{totalRecv} recebidas</span>
          <span style={{ color: 'var(--border)' }}>·</span>
          <span style={{ color: C.Entregues, fontWeight: 600 }}>{totalSent} entregues</span>
          <span style={{ color: 'var(--dim)' }}>· últimas {data.length}h</span>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={chartData} margin={{ top: 2, right: 4, left: -14, bottom: 0 }} barGap={2} barCategoryGap="28%">
          <CartesianGrid strokeDasharray="3 6" stroke="var(--border)" vertical={false} />
          <XAxis dataKey="hour" tick={{ fill: 'var(--dim)', fontSize: 10 }} tickLine={false} axisLine={false} />
          <YAxis tick={{ fill: 'var(--dim)', fontSize: 10 }} tickLine={false} axisLine={false} allowDecimals={false} />
          <Tooltip {...tooltipStyle} />
          <Legend wrapperStyle={{ fontSize: 11, color: 'var(--dim)', paddingTop: 8 }} />
          <Bar dataKey="Recebidas" fill={C.Recebidas} radius={[3,3,0,0]} maxBarSize={24} fillOpacity={0.85} />
          <Bar dataKey="Entregues" fill={C.Entregues} radius={[3,3,0,0]} maxBarSize={24} fillOpacity={0.85} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
