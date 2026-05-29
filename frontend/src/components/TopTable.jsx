/**
 * Tabela de top remetentes / IPs / domínios — identidade AVILI light.
 * accentColor: 'sky' (default) | 'red' | 'amber'
 */

const ACCENT = {
  sky:   { bar0: '#0EA5E9', bar1: '#38BDF8', bar2: '#BAE6FD', rank0bg: '#0EA5E9', rank0text: '#fff' },
  red:   { bar0: '#EF4444', bar1: '#F87171', bar2: '#FECACA', rank0bg: '#EF4444', rank0text: '#fff' },
  amber: { bar0: '#F59E0B', bar1: '#FCD34D', bar2: '#FDE68A', rank0bg: '#F59E0B', rank0text: '#fff' },
}

export default function TopTable({ title, rows = [], emptyMsg = 'Nenhum dado', loading = false, accentColor = 'sky' }) {
  const max = rows[0]?.count || 1
  const A   = ACCENT[accentColor] ?? ACCENT.sky

  const barColor = (i) => {
    if (i === 0) return A.bar0
    if (i === 1) return A.bar1
    return A.bar2
  }

  return (
    <div className="card flex flex-col gap-3 min-w-0">
      <span className="section-label">{title}</span>

      {loading ? (
        <div className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className="h-3 rounded animate-pulse" style={{ width: `${80 - i * 15}%`, background: '#E2E8F0' }} />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--dim)', fontStyle: 'italic' }}>{emptyMsg}</p>
      ) : (
        <ul className="space-y-2.5">
          {rows.map(({ label, count, tag }, i) => (
            <li key={i} className="flex items-center gap-2.5">
              {/* Rank */}
              <span style={{
                width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                background: i === 0 ? A.rank0bg : '#F1F5F9',
                color: i === 0 ? A.rank0text : 'var(--muted)',
                fontSize: 10, fontWeight: 700,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {i + 1}
              </span>

              {/* Barra + label */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-1 mb-1">
                  <span className="truncate" style={{ fontSize: 12, color: 'var(--text)', fontWeight: 500 }} title={label}>
                    {label}
                  </span>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {tag && (
                      <span style={{
                        padding: '1px 6px', borderRadius: 999,
                        fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
                        textTransform: 'uppercase',
                        background: '#F0F9FF', border: '1px solid #BAE6FD', color: '#0369A1',
                      }}>
                        {tag}
                      </span>
                    )}
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
                      {count}
                    </span>
                  </div>
                </div>
                {/* Barra proporcional */}
                <div style={{ height: 3, borderRadius: 999, background: '#F1F5F9', overflow: 'hidden' }}>
                  <div style={{
                    width: `${Math.max(6, (count / max) * 100)}%`,
                    height: '100%', borderRadius: 999,
                    background: barColor(i),
                    transition: 'width 0.5s ease',
                  }} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
