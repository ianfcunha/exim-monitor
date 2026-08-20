/**
 * DiagnosisPanel — painel de diagnóstico colapsável.
 *
 * Comportamento:
 *   - OK   → começa colapsado; mostra só badge verde pequeno
 *   - HIGH/CRITICAL → auto-expande; mostra ações recomendadas em destaque
 *
 * Props:
 *   diagnosis     → { problem, severity, description, actions_recommended? }
 *   onAction(cmd) → chamado ao clicar numa ação rápida (opcional)
 */
import { ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import StatusBadge from './StatusBadge'

// ── Mapeamento problema → ações ───────────────────────────────────────────
const ACTIONS_BY_PROBLEM = {
  SPAM_RELAY:         ['clean-full', 'clean-bounces', 'block-ip'],
  SPAM_MASSIVO:       ['clean-full', 'clean-sender', 'block-ip'],
  AUTH_ABUSE:         ['clean-auth', 'clean-frozen'],
  BOUNCE_CONCENTRADO: ['clean-bounces', 'clean-full'],
  IP_FLOOD:           ['block-ip', 'clean-full', 'clean-frozen'],
  FILA_TRAVADA:       ['clean-frozen', 'retry-queue'],
  ALTO_DEFERIMENTO:   ['clean-bounces', 'clean-frozen', 'retry-queue'],
  BOUNCE_STORM:       ['clean-bounces', 'clean-frozen', 'retry-queue'],
  ALTA_REJEICAO:      ['clean-bounces', 'clean-frozen', 'retry-queue'],
  FILA_ALTA:          ['retry-queue', 'clean-frozen'],
  NORMAL:             [],
}

const ACTION_LABELS = {
  'clean-full':    'Limpar toda a fila',
  'clean-bounces': 'Limpar bounces',
  'clean-frozen':  'Remover frozen',
  'clean-sender':  'Limpar remetente',
  'clean-auth':    'Limpar usuário auth',
  'block-ip':      'Bloquear IP',
  'retry-queue':   'Forçar reprocessamento',
}

// Estilos por ação — ação principal é a primeira da lista. Chip sólido
// escuro DE PROPÓSITO nos dois temas (não var(--text), que vira quase
// branco no escuro) — é o único badge "cheio" da lista, contraste com
// os outros que são outline/pastel.
const ACTION_STYLE_PRIMARY = {
  bg: '#1E293B', border: '#1E293B', text: '#fff',
}
const ACTION_STYLES = {
  'clean-full':    { bg: 'var(--danger-bg)', border: 'var(--danger-border)', text: 'var(--danger)' },
  'clean-bounces': { bg: 'var(--warn-bg)', border: 'var(--warn-border)', text: 'var(--warn)' },
  'clean-frozen':  { bg: 'var(--warn-bg)', border: 'var(--warn-border)', text: 'var(--warn)' },
  'clean-sender':  { bg: 'var(--warn-bg)', border: 'var(--warn-border)', text: 'var(--warn)' },
  'clean-auth':    { bg: 'var(--danger-bg)', border: 'var(--danger-border)', text: 'var(--danger)' },
  'block-ip':      { bg: 'var(--danger-bg)', border: 'var(--danger-border)', text: 'var(--danger)' },
  'retry-queue':   { bg: 'var(--accent-bg)', border: 'var(--accent-border)', text: 'var(--accent-fg)' },
}

// Cores de fundo do painel por severidade
const SEVERITY_BG = {
  OK:       { bg: 'var(--ok-bg)', border: 'var(--ok-border)', dot: 'var(--ok)' },
  LOW:      { bg: 'var(--ok-bg)', border: 'var(--ok-border)', dot: 'var(--ok)' },
  MEDIUM:   { bg: 'var(--warn-bg)', border: 'var(--warn-border)', dot: 'var(--warn)' },
  HIGH:     { bg: 'var(--warn-bg)', border: 'var(--warn-border)', dot: '#EA580C' },
  CRITICAL: { bg: 'var(--danger-bg)', border: 'var(--danger-border)', dot: 'var(--danger)' },
}

export default function DiagnosisPanel({ diagnosis, onAction }) {
  const prevSeverity = useRef(null)
  const [collapsed, setCollapsed] = useState(true)

  const { problem = 'NORMAL', severity = 'OK', description = '' } = diagnosis ?? {}
  const isOk            = severity === 'OK' || severity === 'LOW'
  const isCritical      = severity === 'CRITICAL' || severity === 'HIGH'
  const recommendedActions = ACTIONS_BY_PROBLEM[problem] ?? []
  const colors          = SEVERITY_BG[severity] ?? SEVERITY_BG.OK

  // Auto-expande quando status piora; auto-colapsa quando volta a OK
  useEffect(() => {
    if (prevSeverity.current === severity) return
    prevSeverity.current = severity
    if (isOk) setCollapsed(true)
    else      setCollapsed(false)
  }, [severity, isOk])

  if (!diagnosis) return null

  return (
    <div
      className="card"
      style={{
        border: `1px solid ${colors.border}`,
        background: collapsed ? 'var(--card)' : colors.bg,
        transition: 'background 0.25s, border-color 0.25s',
        padding: 0,
        overflow: 'hidden',
      }}
    >
      {/* ── Cabeçalho (sempre visível) ── */}
      <button
        onClick={() => setCollapsed(v => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center',
          gap: 10, padding: '12px 16px',
          background: 'transparent', border: 'none', cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        {/* Dot de status */}
        <span style={{
          width: 10, height: 10, borderRadius: '50%',
          background: colors.dot, flexShrink: 0,
          boxShadow: isCritical ? `0 0 0 3px ${colors.dot}30` : undefined,
          animation: isCritical ? 'pulseDot 2s ease-in-out infinite' : undefined,
        }} />

        <span className="section-label" style={{ flex: 1 }}>Diagnóstico</span>

        <StatusBadge severity={severity} problem={problem} description={description} />

        <ChevronDown
          size={14}
          color="var(--dim)"
          style={{
            transition: 'transform 0.2s',
            transform: collapsed ? 'rotate(0deg)' : 'rotate(180deg)',
            flexShrink: 0,
          }}
        />
      </button>

      {/* ── Corpo colapsável ── */}
      {!collapsed && (
        <div style={{ padding: '0 16px 16px' }}>
          {/* Descrição */}
          {description && (
            <p style={{ fontSize: 13, color: 'var(--text)', marginBottom: 12, lineHeight: 1.5 }}>
              {description}
            </p>
          )}

          {/* Ações recomendadas */}
          {recommendedActions.length > 0 && (
            <div>
              <p style={{ fontSize: 11, color: 'var(--dim)', marginBottom: 8, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Ações recomendadas
              </p>
              <div className="flex flex-wrap gap-2">
                {recommendedActions.map((action, i) => {
                  const isPrimary = i === 0 && isCritical
                  const st = isPrimary ? ACTION_STYLE_PRIMARY : (ACTION_STYLES[action] ?? ACTION_STYLES['retry-queue'])
                  return (
                    <button
                      key={action}
                      onClick={() => onAction?.(action)}
                      style={{
                        borderRadius: 8,
                        border: `1px solid ${st.border}`,
                        padding: isPrimary ? '7px 16px' : '5px 12px',
                        fontSize: isPrimary ? 12 : 11,
                        fontWeight: isPrimary ? 700 : 500,
                        color: st.text,
                        background: st.bg,
                        cursor: 'pointer',
                        transition: 'filter 0.15s, transform 0.1s',
                        boxShadow: isPrimary ? '0 2px 8px rgba(0,0,0,0.12)' : undefined,
                      }}
                      onMouseEnter={e => {
                        e.currentTarget.style.filter = 'brightness(0.93)'
                        if (isPrimary) e.currentTarget.style.transform = 'translateY(-1px)'
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.filter = 'none'
                        e.currentTarget.style.transform = 'none'
                      }}
                    >
                      {ACTION_LABELS[action] ?? action}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}

      <style>{`
        @keyframes pulseDot {
          0%, 100% { box-shadow: 0 0 0 0px ${colors.dot}50; }
          50%       { box-shadow: 0 0 0 5px ${colors.dot}00; }
        }
      `}</style>
    </div>
  )
}
