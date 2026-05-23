/**
 * Painel de diagnóstico — identidade AVILI light profissional.
 */
import StatusBadge from './StatusBadge'

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
  'clean-auth':    'Limpar usuário',
  'block-ip':      'Bloquear IP',
  'retry-queue':   'Forçar reprocessamento',
}

const ACTION_STYLE = {
  'clean-full':    { bg: '#FEF2F2', border: '#FECACA', text: '#991B1B' },
  'clean-bounces': { bg: '#FFF7ED', border: '#FED7AA', text: '#9A3412' },
  'clean-frozen':  { bg: '#FFFBEB', border: '#FDE68A', text: '#92400E' },
  'clean-sender':  { bg: '#FFF7ED', border: '#FED7AA', text: '#9A3412' },
  'clean-auth':    { bg: '#FEF2F2', border: '#FECACA', text: '#991B1B' },
  'block-ip':      { bg: '#FEF2F2', border: '#FECACA', text: '#991B1B' },
  'retry-queue':   { bg: '#F0F9FF', border: '#BAE6FD', text: '#0369A1' },
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
          <p style={{ fontSize: 11, color: 'var(--dim)', marginBottom: 8 }}>Ações recomendadas:</p>
          <div className="flex flex-wrap gap-2">
            {recommendedActions.map((action) => {
              const st = ACTION_STYLE[action] ?? ACTION_STYLE['retry-queue']
              return (
                <button
                  key={action}
                  onClick={() => onAction?.(action)}
                  style={{
                    borderRadius: 8,
                    border: `1px solid ${st.border}`,
                    padding: '5px 12px',
                    fontSize: 11, fontWeight: 500,
                    color: st.text,
                    background: st.bg,
                    cursor: 'pointer',
                    transition: 'filter 0.15s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.filter = 'brightness(0.96)'}
                  onMouseLeave={e => e.currentTarget.style.filter = 'none'}
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
