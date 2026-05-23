/**
 * Painel de diagnóstico — identidade AVILI light.
 */
import StatusBadge from './StatusBadge'

const ACTIONS_BY_PROBLEM = {
  SPAM_RELAY:          ['clean-full', 'clean-bounces', 'block-ip'],
  SPAM_MASSIVO:        ['clean-full', 'clean-sender', 'block-ip'],
  AUTH_ABUSE:          ['clean-auth', 'clean-frozen'],
  BOUNCE_CONCENTRADO:  ['clean-bounces', 'clean-full'],
  IP_FLOOD:            ['block-ip', 'clean-full', 'clean-frozen'],
  FILA_TRAVADA:        ['clean-frozen', 'retry-queue'],
  ALTO_DEFERIMENTO:    ['clean-bounces', 'clean-frozen', 'retry-queue'],
  BOUNCE_STORM:        ['clean-bounces', 'clean-frozen', 'retry-queue'],
  ALTA_REJEICAO:       ['clean-bounces', 'clean-frozen', 'retry-queue'],
  FILA_ALTA:           ['retry-queue', 'clean-frozen'],
  NORMAL:              [],
}

const ACTION_LABELS = {
  'clean-full':    'Limpar toda a fila',
  'clean-bounces': 'Limpar bounces',
  'clean-frozen':  'Remover frozen',
  'clean-sender':  'Limpar remetente',
  'clean-auth':    'Limpar usuário',
  'block-ip':      'Bloquear IP',
  'retry-queue':   'Forçar reprocessamento',
}

// Cores dos botões de ação — semântica mantida, estilo AVILI light
const ACTION_STYLE = {
  'clean-full':    { border: 'rgba(239,68,68,0.35)',   color: '#DC2626', hover: 'rgba(239,68,68,0.08)'   },
  'clean-bounces': { border: 'rgba(249,115,22,0.35)',  color: '#C2410C', hover: 'rgba(249,115,22,0.08)'  },
  'clean-frozen':  { border: 'rgba(251,191,36,0.40)',  color: '#B45309', hover: 'rgba(251,191,36,0.08)'  },
  'clean-sender':  { border: 'rgba(249,115,22,0.35)',  color: '#C2410C', hover: 'rgba(249,115,22,0.08)'  },
  'clean-auth':    { border: 'rgba(239,68,68,0.35)',   color: '#DC2626', hover: 'rgba(239,68,68,0.08)'   },
  'block-ip':      { border: 'rgba(239,68,68,0.35)',   color: '#DC2626', hover: 'rgba(239,68,68,0.08)'   },
  'retry-queue':   { border: 'rgba(14,165,233,0.35)',  color: '#0369A1', hover: 'rgba(14,165,233,0.08)'  },
}

export default function DiagnosisPanel({ diagnosis, onAction }) {
  if (!diagnosis) return null

  const { problem = 'NORMAL', severity = 'OK', description = '' } = diagnosis
  const recommendedActions = ACTIONS_BY_PROBLEM[problem] ?? []

  return (
    <div className="card space-y-3">
      <span className="section-label">Diagnóstico</span>

      <StatusBadge severity={severity} problem={problem} description={description} large />

      {recommendedActions.length > 0 && (
        <div>
          <p className="text-[11px] mb-2" style={{ color: 'var(--dim)' }}>Ações recomendadas:</p>
          <div className="flex flex-wrap gap-2">
            {recommendedActions.map((action) => {
              const st = ACTION_STYLE[action] ?? ACTION_STYLE['retry-queue']
              return (
                <button
                  key={action}
                  onClick={() => onAction?.(action)}
                  style={{
                    borderRadius: 10,
                    border: `1px solid ${st.border}`,
                    padding: '5px 12px',
                    fontSize: 11,
                    fontWeight: 500,
                    color: st.color,
                    background: 'transparent',
                    cursor: 'pointer',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = st.hover}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  {ACTION_LABELS[action] ?? action}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
