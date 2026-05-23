/**
 * HourlyBarChart — Tráfego por hora via hourly_stats do --quick.
 *
 * Consome q.hourly_stats[] = [{hour, recv, sent}] e renderiza
 * um BarChart Recharts com barras agrupadas por hora.
 * Identidade visual AVILI: paleta sky / cyan / green.
 */
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

const C = {
  Recebidas: '#22C55E',  // green-500
  Entregues: '#22D3EE',  // cyan-400
}

const tooltipStyle = {
  contentStyle: {
    background: 'rgba(8,15,30,0.94)',
    border: '1px solid rgba(14,165,233,0.25)',
    borderRadius: 12,
    backdropFilter: 'blur(20px)',
    WebkitBackdropFilter: 'blur(20px)',
    boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
  },
  labelStyle: { color: 'rgba(226,234,244,0.5)', fontSize: 11, marginBottom: 4 },
  itemStyle: { fontSize: 11 },
  cursor: { fill: 'rgba(14,165,233,0.06)' },
}

export default function HourlyBarChart({ data = [], loading = false }) {
  if (loading) {
    return (
      <div className="card space-y-3">
        <span className="section-label">Tráfego por hora</span>
        <div
          className="rounded-xl animate-pulse"
          style={{ height: 160, background: 'rgba(14,165,233,0.06)' }}
        />
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

        {/* Totais do período */}
        <div style={{ display: 'flex', gap: 12, fontSize: 11 }}>
          <span style={{ color: C.Recebidas, fontWeight: 600 }}>
            {totalRecv} recebidas
          </span>
          <span style={{ color: 'rgba(226,234,244,0.20)' }}>·</span>
          <span style={{ color: C.Entregues, fontWeight: 600 }}>
            {totalSent} entregues
          </span>
          <span style={{ color: 'var(--dim)', fontVariantNumeric: 'tabular-nums' }}>
            · últimas {data.length}h
          </span>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={160}>
        <BarChart
          data={chartData}
          margin={{ top: 2, right: 4, left: -14, bottom: 0 }}
          barGap={2}
          barCategoryGap="28%"
        >
          <CartesianGrid
            strokeDasharray="2 6"
            stroke="rgba(14,165,233,0.06)"
            vertical={false}
          />
          <XAxis
            dataKey="hour"
            tick={{ fill: 'rgba(226,234,244,0.28)', fontSize: 10 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            tick={{ fill: 'rgba(226,234,244,0.28)', fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
          />
          <Tooltip {...tooltipStyle} />
          <Legend
            wrapperStyle={{
              fontSize: 11,
              color: 'rgba(226,234,244,0.40)',
              paddingTop: 8,
            }}
          />
          <Bar
            dataKey="Recebidas"
            fill={C.Recebidas}
            radius={[3, 3, 0, 0]}
            maxBarSize={24}
            fillOpacity={0.80}
          />
          <Bar
            dataKey="Entregues"
            fill={C.Entregues}
            radius={[3, 3, 0, 0]}
            maxBarSize={24}
            fillOpacity={0.80}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
