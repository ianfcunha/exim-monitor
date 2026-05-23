/**
 * MetricCard — estilo Flowbite/admin com identidade AVILI.
 * Ícone em caixa sky-blue, número grande escuro, label uppercase.
 */
export default function MetricCard({
  icon: Icon,
  label,
  value,
  sub,
  loading = false,
}) {
  return (
    <div className="card card-interactive flex flex-col gap-3 min-w-0">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="section-label truncate mb-1">{label}</p>
          {loading ? (
            <div
              className="h-9 w-24 rounded-lg animate-pulse"
              style={{ background: '#E2E8F0' }}
            />
          ) : (
            <p style={{
              fontSize: 28, fontWeight: 800, color: 'var(--night)',
              lineHeight: 1, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums',
            }}>
              {value ?? '—'}
            </p>
          )}
          {sub && !loading && (
            <p style={{ fontSize: 11, color: 'var(--dim)', marginTop: 4 }}>{sub}</p>
          )}
        </div>

        {Icon && (
          <div style={{
            width: 40, height: 40, borderRadius: 10, flexShrink: 0,
            background: 'rgba(14,165,233,0.10)',
            border: '1px solid rgba(14,165,233,0.18)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Icon size={18} color="#0EA5E9" strokeWidth={1.8} />
          </div>
        )}
      </div>
    </div>
  )
}
