/**
 * Card de métrica — identidade AVILI light.
 * Ícone Lucide em sky-blue, label em uppercase tracking wide,
 * valor principal com accent por severidade.
 */
export default function MetricCard({
  icon: Icon,
  label,
  value,
  sub,
  accent = 'text-sky-600',
  loading = false,
}) {
  return (
    <div className="card card-interactive flex flex-col gap-2 min-w-0">
      {/* Label + ícone */}
      <div className="flex items-center justify-between gap-2">
        <span className="section-label truncate">{label}</span>
        {Icon && (
          <div
            className="flex-shrink-0 flex items-center justify-center rounded-lg"
            style={{
              width: 30, height: 30,
              background: 'rgba(14,165,233,0.10)',
              border: '1px solid rgba(14,165,233,0.22)',
            }}
          >
            <Icon size={14} color="#0EA5E9" strokeWidth={1.8} />
          </div>
        )}
      </div>

      {/* Valor */}
      {loading ? (
        <div
          className="h-8 w-20 rounded-lg animate-pulse"
          style={{ background: 'rgba(14,165,233,0.10)' }}
        />
      ) : (
        <p className={`text-3xl font-bold tabular-nums tracking-tight leading-none ${accent}`}
           style={{ color: 'var(--night)' }}>
          {value ?? '—'}
        </p>
      )}

      {/* Sub-texto */}
      {sub && !loading && (
        <p className="text-[11px] truncate" style={{ color: 'var(--dim)' }}>{sub}</p>
      )}
    </div>
  )
}
