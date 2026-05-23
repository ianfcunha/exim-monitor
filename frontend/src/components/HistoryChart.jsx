/**
 * Gráfico de histórico — identidade AVILI light.
 * Fila em sky-blue, Entregues em cyan, Rejeitados/Deferidos em semântica.
 */
import { useEffect, useState } from 'react'
import {
  Area, AreaChart, CartesianGrid, Legend,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { fetchHistory } from '../api/client'

const HOURS_OPTIONS = [6, 12, 24, 48]

function formatTime(isoStr) {
  const d = new Date(isoStr)
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

const C = {
  Fila:       '#0EA5E9',
  Entregues:  '#0891B2',
  Rejeitados: '#DC2626',
  Deferidos:  '#D97706',
}

export default function HistoryChart() {
  const [data, setData]       = useState([])
  const [hours, setHours]     = useState(24)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetchHistory(hours, 'quick')
      .then((rows) =>
        setData(rows.map((r) => ({
          time:       formatTime(r.timestamp),
          Fila:       r.queue_total,
          Entregues:  r.delivered,
          Rejeitados: r.rejected,
          Deferidos:  r.deferred,
        })))
      )
      .catch(() => setData([]))
      .finally(() => setLoading(false))
  }, [hours])

  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between">
        <span className="section-label">Histórico de tráfego</span>

        {/* Seletor de período — estilo AVILI pill */}
        <div
          style={{
            display: 'flex', gap: 2, padding: 3, borderRadius: 10,
            background: 'rgba(14,165,233,0.07)',
            border: '1px solid rgba(14,165,233,0.16)',
          }}
        >
          {HOURS_OPTIONS.map((h) => (
            <button
              key={h}
              onClick={() => setHours(h)}
              style={{
                borderRadius: 7, padding: '4px 11px',
                fontSize: 11, fontWeight: 500,
                background:  hours === h ? 'rgba(14,165,233,0.18)' : 'transparent',
                color:       hours === h ? '#0369A1' : 'rgba(15,26,46,0.40)',
                border:      hours === h ? '1px solid rgba(14,165,233,0.35)' : '1px solid transparent',
                cursor: 'pointer', transition: 'all 0.15s',
              }}
            >
              {h}h
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div
          className="h-52 rounded-xl animate-pulse"
          style={{ background: 'rgba(14,165,233,0.07)' }}
        />
      ) : data.length === 0 ? (
        <p className="text-xs italic text-center py-10" style={{ color: 'var(--dim)' }}>
          Sem dados suficientes ainda — aguarde alguns ciclos de coleta.
        </p>
      ) : (
        <ResponsiveContainer width="100%" height={210}>
          <AreaChart data={data} margin={{ top: 4, right: 4, left: -14, bottom: 0 }}>
            <defs>
              <linearGradient id="gFila" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={C.Fila}      stopOpacity={0.22} />
                <stop offset="95%" stopColor={C.Fila}      stopOpacity={0}    />
              </linearGradient>
              <linearGradient id="gEntregues" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={C.Entregues} stopOpacity={0.18} />
                <stop offset="95%" stopColor={C.Entregues} stopOpacity={0}    />
              </linearGradient>
            </defs>

            <CartesianGrid
              strokeDasharray="2 6"
              stroke="rgba(14,165,233,0.10)"
              vertical={false}
            />
            <XAxis
              dataKey="time"
              tick={{ fill: 'rgba(15,26,46,0.35)', fontSize: 10 }}
              tickLine={false} axisLine={false}
            />
            <YAxis
              tick={{ fill: 'rgba(15,26,46,0.35)', fontSize: 10 }}
              tickLine={false} axisLine={false}
            />
            <Tooltip
              contentStyle={{
                background: 'rgba(255,255,255,0.92)',
                border: '1px solid rgba(14,165,233,0.22)',
                borderRadius: 12,
                backdropFilter: 'blur(20px)',
                WebkitBackdropFilter: 'blur(20px)',
                boxShadow: '0 8px 32px rgba(14,100,180,0.12)',
              }}
              labelStyle={{ color: 'rgba(15,26,46,0.55)', fontSize: 11, marginBottom: 4 }}
              itemStyle={{ fontSize: 11, color: '#0F1A2E' }}
              cursor={{ stroke: 'rgba(14,165,233,0.20)', strokeWidth: 1 }}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: 'rgba(15,26,46,0.45)', paddingTop: 8 }} />

            <Area type="monotone" dataKey="Fila"
              stroke={C.Fila} fill="url(#gFila)" strokeWidth={1.5}
              dot={false} activeDot={{ r: 3, fill: C.Fila, stroke: 'none' }} />
            <Area type="monotone" dataKey="Entregues"
              stroke={C.Entregues} fill="url(#gEntregues)" strokeWidth={1.5}
              dot={false} activeDot={{ r: 3, fill: C.Entregues, stroke: 'none' }} />
            <Area type="monotone" dataKey="Rejeitados"
              stroke={C.Rejeitados} fill="none" strokeWidth={1}
              dot={false} strokeDasharray="4 3"
              activeDot={{ r: 3, fill: C.Rejeitados, stroke: 'none' }} />
            <Area type="monotone" dataKey="Deferidos"
              stroke={C.Deferidos} fill="none" strokeWidth={1}
              dot={false} strokeDasharray="4 3"
              activeDot={{ r: 3, fill: C.Deferidos, stroke: 'none' }} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
