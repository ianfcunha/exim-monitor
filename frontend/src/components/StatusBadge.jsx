/**
 * Badge de severidade — identidade AVILI light.
 * OK usa sky-blue (alinhado ao brand); demais mantêm semântica de cor.
 */

const S = {
  OK:       { border: 'rgba(14,165,233,0.35)',  bg: 'rgba(14,165,233,0.10)',  text: '#0369A1', dot: '#0EA5E9',  glow: '0 0 12px rgba(14,165,233,0.15)'   },
  LOW:      { border: 'rgba(34,211,238,0.35)',  bg: 'rgba(34,211,238,0.10)',  text: '#0891B2', dot: '#22D3EE',  glow: ''                                  },
  MEDIUM:   { border: 'rgba(251,191,36,0.40)',  bg: 'rgba(251,191,36,0.10)',  text: '#B45309', dot: '#FBBF24',  glow: ''                                  },
  HIGH:     { border: 'rgba(249,115,22,0.40)',  bg: 'rgba(249,115,22,0.10)',  text: '#C2410C', dot: '#F97316',  glow: '0 0 12px rgba(249,115,22,0.12)'    },
  CRITICAL: { border: 'rgba(239,68,68,0.40)',   bg: 'rgba(239,68,68,0.10)',   text: '#DC2626', dot: '#EF4444',  glow: '0 0 16px rgba(239,68,68,0.18)'     },
}

export default function StatusBadge({ severity = 'OK', problem, description, large = false }) {
  const s = S[severity] ?? S.OK
  const isCritical = severity === 'CRITICAL'

  if (large) {
    return (
      <div
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 12,
          borderRadius: 12, padding: '12px 16px',
          background: s.bg, border: `1px solid ${s.border}`,
          backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
          boxShadow: s.glow || undefined,
        }}
      >
        <span style={{
          marginTop: 3, width: 9, height: 9, borderRadius: '50%',
          background: s.dot, flexShrink: 0,
          animation: isCritical ? 'pulse-sky 2s ease-in-out infinite' : undefined,
        }} />
        <div>
          <p style={{ fontWeight: 700, fontSize: 13, letterSpacing: '0.03em', color: s.text }}>
            {severity} — {problem}
          </p>
          {description && (
            <p style={{ marginTop: 3, fontSize: 11, color: s.text, opacity: 0.75 }}>{description}</p>
          )}
        </div>
      </div>
    )
  }

  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        borderRadius: 20, padding: '3px 10px',
        fontSize: 11, fontWeight: 600, letterSpacing: '0.04em',
        background: s.bg, border: `1px solid ${s.border}`, color: s.text,
        backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
        boxShadow: s.glow || undefined,
      }}
    >
      <span style={{
        width: 6, height: 6, borderRadius: '50%', background: s.dot, flexShrink: 0,
        animation: isCritical ? 'pulse-sky 2s ease-in-out infinite' : undefined,
      }} />
      {severity}
    </span>
  )
}
