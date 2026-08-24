/**
 * MetricCard — estilo Flowbite/admin com identidade AVILI.
 * Ícone em caixa sky-blue, número grande escuro, label uppercase.
 * Aceita:
 *   onClick       → abre drawer de detalhes
 *   trend         → número: positivo=subiu, negativo=caiu, null=sem histórico
 *   trendPositive → 'up' (verde quando sobe) | 'down' (verde quando cai)
 *   tooltip       → texto explicativo exibido ao hover no label
 */
import { TrendingDown, TrendingUp } from 'lucide-react'
import { useRef, useState } from 'react'

/* ── Indicador de tendência ── */
function TrendBadge({ value, positive }) {
  if (value == null || value === 0) return null
  const isGood  = positive === 'up' ? value > 0 : value < 0
  const color   = isGood ? 'var(--ok)' : 'var(--danger)'
  const bg      = isGood ? 'rgba(22,163,74,0.09)' : 'rgba(220,38,38,0.09)'
  const Icon    = value > 0 ? TrendingUp : TrendingDown
  const sign    = value > 0 ? '+' : ''
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      fontSize: 10, fontWeight: 700, color,
      background: bg, borderRadius: 999,
      padding: '2px 6px', lineHeight: 1,
    }}>
      <Icon size={10} strokeWidth={2.5} />
      {sign}{value}
    </span>
  )
}

/* ── Tooltip simples ── */
function Tip({ text, children }) {
  const [vis, setVis]   = useState(false)
  const timerRef        = useRef(null)

  if (!text) return children

  const show = () => { timerRef.current = setTimeout(() => setVis(true), 350) }
  const hide = () => { clearTimeout(timerRef.current); setVis(false) }

  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      {children}
      {vis && (
        <span style={{
          position: 'absolute',
          bottom: 'calc(100% + 7px)',
          left: '50%',
          transform: 'translateX(-50%)',
          background: 'var(--text)',
          color: 'var(--surface)',
          fontSize: 11,
          fontWeight: 400,
          borderRadius: 7,
          padding: '6px 10px',
          whiteSpace: 'normal',
          maxWidth: 220,
          lineHeight: 1.5,
          zIndex: 200,
          boxShadow: '0 4px 16px rgba(0,0,0,0.22)',
          pointerEvents: 'none',
        }}>
          {text}
          {/* seta */}
          <span style={{
            position: 'absolute', top: '100%', left: '50%',
            transform: 'translateX(-50%)',
            borderWidth: '5px 5px 0',
            borderStyle: 'solid',
            borderColor: 'var(--text) transparent transparent',
          }} />
        </span>
      )}
    </span>
  )
}

/* ── Componente principal ── */
export default function MetricCard({
  icon: Icon,
  label,
  value,
  sub,
  loading    = false,
  onClick,
  trend      = null,    // diff numérico vs coleta anterior
  trendPositive = 'up', // 'up' | 'down'
  tooltip    = null,    // texto explicativo
}) {
  const [hov, setHov] = useState(false)

  return (
    <div
      className="card card-interactive flex flex-col gap-3 min-w-0"
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        cursor: onClick ? 'pointer' : undefined,
        transition: 'box-shadow 0.15s, transform 0.15s',
        transform: hov && onClick ? 'translateY(-1px)' : undefined,
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div style={{ flex: 1, minWidth: 0 }}>

          {/* Label + tooltip */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
            <Tip text={tooltip}>
              <p
                className="section-label truncate"
                style={{ cursor: tooltip ? 'help' : undefined }}
              >
                {label}
              </p>
              {tooltip && (
                <span style={{
                  fontSize: 9, color: 'var(--dim)',
                  marginLeft: 3, cursor: 'help',
                  userSelect: 'none',
                }}>ⓘ</span>
              )}
            </Tip>
          </div>

          {/* Valor */}
          {loading ? (
            <div
              className="h-9 w-24 rounded-lg animate-pulse"
              style={{ background: 'var(--border)' }}
            />
          ) : (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
              <p style={{
                fontSize: 28, fontWeight: 800, color: 'var(--night)',
                lineHeight: 1, letterSpacing: '-0.02em',
                fontVariantNumeric: 'tabular-nums',
              }}>
                {value ?? '—'}
              </p>
              <TrendBadge value={trend} positive={trendPositive} />
            </div>
          )}

          {/* Sub-texto */}
          {sub && !loading && (
            <p style={{ fontSize: 11, color: 'var(--dim)', marginTop: 4 }}>{sub}</p>
          )}
        </div>

        {/* Ícone */}
        {Icon && (
          <div style={{
            width: 40, height: 40, borderRadius: 10, flexShrink: 0,
            background: 'rgba(228,87,46,0.10)',
            border: '1px solid rgba(228,87,46,0.18)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Icon size={18} color="var(--sky)" strokeWidth={1.8} />
          </div>
        )}
      </div>
    </div>
  )
}
