/**
 * Badge de severidade — identidade AVILI light profissional.
 */

const S = {
  OK:       { border: 'var(--accent-border)', bg: 'var(--accent-bg)', text: 'var(--accent-fg)', dot: 'var(--sky)' },
  LOW:      { border: 'color-mix(in srgb, var(--cyan) 40%, var(--border))', bg: 'color-mix(in srgb, var(--cyan) 12%, var(--card))', text: 'color-mix(in srgb, var(--cyan) 70%, var(--text))', dot: 'var(--cyan)' },
  MEDIUM:   { border: 'var(--warn-border)', bg: 'var(--warn-bg)', text: 'var(--warn)', dot: 'var(--warn)' },
  HIGH:     { border: 'var(--warn-border)', bg: 'var(--warn-bg)', text: 'var(--warn)', dot: '#F97316' },
  CRITICAL: { border: 'var(--danger-border)', bg: 'var(--danger-bg)', text: 'var(--danger)', dot: 'var(--danger)' },
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
