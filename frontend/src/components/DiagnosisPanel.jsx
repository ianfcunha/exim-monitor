/**
 * DiagnosisPanel — painel de diagnóstico colapsável.
 *
 * Comportamento:
 *   - OK   → começa colapsado; mostra só badge verde pequeno
 *   - HIGH/CRITICAL → auto-expande
 *
 * Props:
 *   diagnosis → { problem, severity, description, actions_recommended? }
 *
 * T9 (Sessão 1, pós-auditoria — "fechar o gap da auditoria"): este
 * painel tinha seus PRÓPRIOS botões de "ação rápida" (onAction(cmd)),
 * cada um chamando a ação direto — sem plan()/apply(), sem quarentena,
 * sem nenhuma das garantias da Tarefa 3. Só não era um problema porque
 * Dashboard.jsx passava onAction=handleActionComplete, uma função que
 * ignora o argumento e só recarrega os dados — os botões pareciam
 * executar a ação (rótulo, cor, hover), mas na prática não faziam
 * nada. Um dev futuro "consertando" essa ligação (o jeito óbvio seria
 * chamar runAction(action) direto) reintroduziria exatamente o bypass
 * que a Tarefa 3 fechou. Removidos — ActionPanel.jsx já mostra as
 * mesmas ações recomendadas (badge "Sugerido", usando
 * diag.actions_recommended vindo do backend, não uma cópia hardcoded
 * aqui) através do fluxo plan()→preview→apply() de verdade.
 */
import { ChevronDown } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import StatusBadge from './StatusBadge'

// Só pra exibição em texto (não clicáveis) — a ação de verdade mora
// em ActionPanel.jsx, com o rótulo já em português lá também.
const ACTION_LABELS = {
  'clean-full':    'Limpar toda a fila',
  'clean-bounces': 'Limpar bounces',
  'clean-frozen':  'Remover frozen',
  'clean-sender':  'Limpar remetente',
  'clean-auth':    'Limpar usuário auth',
  'block-ip':      'Bloquear IP',
  'block-sender':  'Bloquear remetente',
  'retry-queue':   'Forçar reprocessamento',
}

// Cores de fundo do painel por severidade
const SEVERITY_BG = {
  OK:       { bg: 'var(--ok-bg)', border: 'var(--ok-border)', dot: 'var(--ok)' },
  LOW:      { bg: 'var(--ok-bg)', border: 'var(--ok-border)', dot: 'var(--ok)' },
  MEDIUM:   { bg: 'var(--warn-bg)', border: 'var(--warn-border)', dot: 'var(--warn)' },
  HIGH:     { bg: 'var(--warn-bg)', border: 'var(--warn-border)', dot: '#EA580C' },
  CRITICAL: { bg: 'var(--danger-bg)', border: 'var(--danger-border)', dot: 'var(--danger)' },
  // T6 (Sessão 1, pós-auditoria): sem entrada própria, um servidor
  // DEGRADED (log não reconhecido) ou UNKNOWN (nunca respondeu de
  // verdade) caía no fallback ?? SEVERITY_BG.OK — colapsado, verde,
  // como se estivesse tudo bem. Mesmo bug de StatusBadge.jsx.
  DEGRADED: { bg: 'var(--danger-bg)', border: 'var(--danger-border)', dot: 'var(--danger)' },
  UNKNOWN:  { bg: 'var(--surface)', border: 'var(--border)', dot: 'var(--dim)' },
}

export default function DiagnosisPanel({ diagnosis }) {
  const prevSeverity = useRef(null)
  const [collapsed, setCollapsed] = useState(true)

  const { problem = 'UNKNOWN', severity = 'UNKNOWN', description = '', actions_recommended: recommendedActions = [] } = diagnosis ?? {}
  const isOk            = severity === 'OK' || severity === 'LOW'
  const isCritical      = severity === 'CRITICAL' || severity === 'HIGH' || severity === 'DEGRADED'
  const colors          = SEVERITY_BG[severity] ?? SEVERITY_BG.UNKNOWN

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

          {/* Ações recomendadas — só informativo. Executar de verdade
              acontece no painel de Ações abaixo (badge "Sugerido"),
              com plan()/apply() de verdade — ver nota no topo do
              arquivo (T9, Sessão 1, pós-auditoria). */}
          {recommendedActions.length > 0 && (
            <div>
              <p style={{ fontSize: 11, color: 'var(--dim)', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                Ações recomendadas
              </p>
              <p style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
                {recommendedActions.map(a => ACTION_LABELS[a] ?? a).join(', ')}
                {' — '}veja o badge <strong>Sugerido</strong> no painel de Ações abaixo.
              </p>
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
