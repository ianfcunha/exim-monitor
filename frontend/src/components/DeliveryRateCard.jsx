/**
 * DeliveryRateCard — exibe taxa de entrega com cor semântica e barra de progresso.
 * Verde ≥95% · Âmbar ≥80% · Vermelho <80%
 */
export default function DeliveryRateCard({ delivered = 0, rejected = 0, deferred = 0, loading = false }) {
  const total = delivered + rejected + deferred
  const rate  = total > 0 ? Math.round((delivered / total) * 100) : null

  const color = rate == null ? '#94A3B8'
    : rate >= 95 ? '#16A34A'
    : rate >= 80 ? '#D97706'
    : '#DC2626'

  const bgColor = rate == null ? '#F1F5F9'
    : rate >= 95 ? '#F0FDF4'
    : rate >= 80 ? '#FFFBEB'
    : '#FEF2F2'

  const borderColor = rate == null ? '#E2E8F0'
    : rate >= 95 ? '#BBF7D0'
    : rate >= 80 ? '#FDE68A'
    : '#FECACA'

  return (
    <div className="card flex flex-col gap-3 min-w-0" style={{ background: bgColor, borderColor }}>
      <div className="flex items-start justify-between gap-2">
        <div style={{ flex: 1, minWidth: 0 }}>
          <p className="section-label truncate mb-1" style={{ color }}>
            Taxa de Entrega
          </p>

          {loading ? (
            <div className="h-9 w-24 rounded-lg animate-pulse" style={{ background: '#E2E8F0' }} />
          ) : (
            <p style={{
              fontSize: 28, fontWeight: 800,
              lineHeight: 1, letterSpacing: '-0.02em',
              fontVariantNumeric: 'tabular-nums',
              color,
            }}>
              {rate != null ? `${rate}%` : '—'}
            </p>
          )}

          {!loading && (
            <p style={{ fontSize: 11, color, opacity: 0.7, marginTop: 4 }}>
              {total > 0
                ? `${delivered} entregues de ${total}`
                : 'sem dados no período'}
            </p>
          )}
        </div>

        {/* Gauge circular simples */}
        {!loading && rate != null && (
          <svg width={40} height={40} viewBox="0 0 40 40" style={{ flexShrink: 0 }}>
            <circle cx="20" cy="20" r="16" fill="none" stroke={borderColor} strokeWidth="4" />
            <circle
              cx="20" cy="20" r="16" fill="none"
              stroke={color} strokeWidth="4"
              strokeDasharray={`${(rate / 100) * 100.53} 100.53`}
              strokeLinecap="round"
              transform="rotate(-90 20 20)"
              style={{ transition: 'stroke-dasharray 0.6s ease' }}
            />
          </svg>
        )}
      </div>

      {/* Barra de progresso */}
      {!loading && (
        <div style={{ height: 3, borderRadius: 999, background: borderColor, overflow: 'hidden' }}>
          <div style={{
            width: rate != null ? `${rate}%` : '0%',
            height: '100%', borderRadius: 999,
            background: color,
            transition: 'width 0.6s ease',
          }} />
        </div>
      )}
    </div>
  )
}
