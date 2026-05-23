/**
 * Tabela de top remetentes / IPs — identidade AVILI light profissional.
 */
export default function TopTable({ title, rows = [], emptyMsg = 'Nenhum dado', loading = false }) {
  const max = rows[0]?.count || 1

  const barColor = (i) => {
    if (i === 0) return '#0EA5E9'
    if (i === 1) return '#38BDF8'
    return '#BAE6FD'
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
                background: i === 0 ? '#0EA5E9' : '#F1F5F9',
                color: i === 0 ? '#fff' : 'var(--muted)',
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
