/**
 * Badge de severidade — identidade AVILI light profissional.
 */

const S = {
  OK:       { border: '#BAE6FD', bg: '#F0F9FF', text: '#0369A1', dot: '#0EA5E9' },
  LOW:      { border: '#A5F3FC', bg: '#ECFEFF', text: '#0E7490', dot: '#22D3EE' },
  MEDIUM:   { border: '#FDE68A', bg: '#FFFBEB', text: '#92400E', dot: '#F59E0B' },
  HIGH:     { border: '#FED7AA', bg: '#FFF7ED', text: '#9A3412', dot: '#F97316' },
  CRITICAL: { border: '#FECACA', bg: '#FEF2F2', text: '#991B1B', dot: '#EF4444' },
}

export default function StatusBadge({ severity = 'OK', problem, description, large = false }) {
  const s = S[severity] ?? S.OK
  const isCritical = severity === 'CRITICAL'

  const dotStyle = {
    width: large ? 9 : 6,
    height: large ? 9 : 6,
    borderRadius: '50%',
    background: s.dot,
    flexShrink: 0,
    animation: isCritical ? 'pulse-sky 2s ease-in-out infinite' : undefined,
  }

  if (large) {
    return (
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        borderRadius: 10, padding: '10px 14px',
        background: s.bg, border: `1px solid ${s.border}`,
      }}>
        <span style={{ ...dotStyle, marginTop: 4 }} />
        <div>
          <p style={{ fontWeight: 700, fontSize: 13, color: s.text }}>
            {severity}{problem && problem !== 'NORMAL' ? ` — ${problem}` : ''}
          </p>
          {description && (
            <p style={{ marginTop: 2, fontSize: 11, color: s.text, opacity: 0.75 }}>{description}</p>
          )}
        </div>
      </div>
    )
  }

  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      borderRadius: 999, padding: '3px 10px',
      fontSize: 11, fontWeight: 600,
      background: s.bg, border: `1px solid ${s.border}`, color: s.text,
    }}>
      <span style={dotStyle} />
      {severity}
    </span>
  )
}
