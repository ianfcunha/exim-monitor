/**
 * Gráfico de histórico — identidade AVILI light.
 */
import { useEffect, useState } from 'react'
import {
  Area, AreaChart, CartesianGrid, Legend,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { fetchHistory } from '../api/client'

const HOURS_OPTIONS = [6, 12, 24, 48]

function formatTime(isoStr) {
  return new Date(isoStr).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

const C = {
  Fila:       '#0EA5E9',
  Entregues:  '#0891B2',
  Rejeitados: '#EF4444',
  Deferidos:  '#F59E0B',
}

export default function HistoryChart() {
  const [data, setData]       = useState([])
  const [hours, setHours]     = useState(24)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetchHistory(hours, 'quick')
      .then(rows => setData(rows.map(r => ({
        time:       formatTime(r.timestamp),
        Fila:       r.queue_total,
        Entregues:  r.delivered,
        Rejeitados: r.rejected,
        Deferidos:  r.deferred,
      }))))
      .catch(() => setData([]))
      .finally(() => setLoading(false))
  }, [hours])

  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <span className="section-label">Histórico de tráfego</span>

        <div style={{
          display: 'flex', gap: 2, padding: 3, borderRadius: 8,
          background: '#F8FAFC', border: '1px solid #E2E8F0',
        }}>
          {HOURS_OPTIONS.map(h => (
            <button
              key={h}
              onClick={() => setHours(h)}
              style={{
                borderRadius: 6, padding: '3px 10px',
                fontSize: 11, fontWeight: 500,
                background: hours === h ? '#0EA5E9' : 'transparent',
                color:      hours === h ? '#fff'    : 'var(--muted)',
                border:     'none', cursor: 'pointer',
                transition: 'all 0.15s',
              }}
            >
              {h}h
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="h-52 rounded-xl animate-pulse" style={{ background: '#F1F5F9' }} />
      ) : data.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--dim)', textAlign: 'center', padding: '40px 0', fontStyle: 'italic' }}>
          Sem dados suficientes — aguarde alguns ciclos de coleta.
        </p>
      ) : (
        <ResponsiveContainer width="100%" height={210}>
          <AreaChart data={data} margin={{ top: 4, right: 4, left: -14, bottom: 0 }}>
            <defs>
              <linearGradient id="gFila" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={C.Fila}     stopOpacity={0.15} />
                <stop offset="95%" stopColor={C.Fila}     stopOpacity={0}    />
              </linearGradient>
              <linearGradient id="gEntregues" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={C.Entregues} stopOpacity={0.12} />
                <stop offset="95%" stopColor={C.Entregues} stopOpacity={0}    />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 6" stroke="#E2E8F0" vertical={false} />
            <XAxis dataKey="time" tick={{ fill: '#94A3B8', fontSize: 10 }} tickLine={false} axisLine={false} />
            <YAxis tick={{ fill: '#94A3B8', fontSize: 10 }} tickLine={false} axisLine={false} />
            <Tooltip
              contentStyle={{
                background: '#fff', border: '1px solid #E2E8F0',
                borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
              }}
              labelStyle={{ color: '#64748B', fontSize: 11, marginBottom: 4 }}
              itemStyle={{ fontSize: 11, color: '#0F172A' }}
              cursor={{ stroke: '#E2E8F0', strokeWidth: 1 }}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: '#94A3B8', paddingTop: 8 }} />
            <Area type="monotone" dataKey="Fila"       stroke={C.Fila}       fill="url(#gFila)"      strokeWidth={2}   dot={false} activeDot={{ r: 3 }} />
            <Area type="monotone" dataKey="Entregues"  stroke={C.Entregues}  fill="url(#gEntregues)" strokeWidth={2}   dot={false} activeDot={{ r: 3 }} />
            <Area type="monotone" dataKey="Rejeitados" stroke={C.Rejeitados} fill="none"             strokeWidth={1.5} dot={false} strokeDasharray="4 3" activeDot={{ r: 3 }} />
            <Area type="monotone" dataKey="Deferidos"  stroke={C.Deferidos}  fill="none"             strokeWidth={1.5} dot={false} strokeDasharray="4 3" activeDot={{ r: 3 }} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}
