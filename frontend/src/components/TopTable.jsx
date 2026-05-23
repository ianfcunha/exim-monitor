/**
 * Tabela de top remetentes / IPs — identidade AVILI light.
 * Barras em sky-blue degradê por posição, rank numerado, tag opcional.
 */
export default function TopTable({ title, rows = [], emptyMsg = 'Nenhum dado', loading = false }) {
  const max = rows[0]?.count || 1

  const barColor = (i) => {
    if (i === 0) return '#0EA5E9'
    if (i === 1) return 'rgba(14,165,233,0.55)'
    return 'rgba(14,165,233,0.30)'
  }

  return (
    <div className="card flex flex-col gap-3 min-w-0">
      <span className="section-label">{title}</span>

      {loading ? (
        <div className="space-y-2.5">
          {[...Array(4)].map((_, i) => (
            <div
              key={i}
              className="h-4 rounded-lg animate-pulse"
              style={{ width: `${84 - i * 13}%`, background: 'rgba(14,165,233,0.10)' }}
            />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="text-xs italic" style={{ color: 'var(--dim)' }}>{emptyMsg}</p>
      ) : (
        <ul className="space-y-2.5">
          {rows.map(({ label, count, tag }, i) => (
            <li
              key={i}
              className="group flex items-center gap-2.5 text-xs"
              style={{ cursor: 'default' }}
            >
              {/* Rank */}
              <span
                className="w-4 flex-shrink-0 text-center tabular-nums font-bold"
                style={{ fontSize: 10, color: 'var(--dim)', transition: 'color .15s' }}
              >
                {i + 1}
              </span>

              {/* Barra proporcional */}
              <div
                className="flex-shrink-0 rounded-full overflow-hidden"
                style={{ width: 48, height: 3, background: 'rgba(14,165,233,0.12)' }}
              >
                <div
                  style={{
                    width: `${Math.max(8, (count / max) * 100)}%`,
                    height: '100%',
                    borderRadius: 999,
                    background: barColor(i),
                    transition: 'width 0.5s ease',
                  }}
                />
              </div>

              {/* Contagem */}
              <span
                className="tabular-nums flex-shrink-0 font-semibold"
                style={{ width: 34, textAlign: 'right', color: 'var(--night)' }}
              >
                {count}
              </span>

              {/* Label */}
              <span
                className="truncate"
                style={{ color: 'var(--muted)', transition: 'color .15s' }}
                title={label}
              >
                {label}
              </span>

              {/* Tag */}
              {tag && (
                <span
                  className="flex-shrink-0"
                  style={{
                    padding: '1px 6px',
                    borderRadius: 20,
                    fontSize: 9,
                    fontWeight: 600,
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    background: 'rgba(14,165,233,0.10)',
                    border: '1px solid rgba(14,165,233,0.28)',
                    color: '#0369A1',
                  }}
                >
                  {tag}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
