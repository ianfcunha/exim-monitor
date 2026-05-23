/**
 * Painel de ações — identidade AVILI light profissional.
 */
import { AlertTriangle, CornerDownLeft, RotateCcw, Snowflake, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { runAction } from '../api/client'
import { useToast } from '../contexts/ToastContext'

const ACTIONS = [
  { id: 'retry-queue',   label: 'Reprocessar fila', Icon: RotateCcw,      color: 'sky'   , confirm: false },
  { id: 'clean-frozen',  label: 'Remover frozen',    Icon: Snowflake,      color: 'amber' , confirm: true  },
  { id: 'clean-bounces', label: 'Limpar bounces',    Icon: CornerDownLeft, color: 'orange', confirm: true  },
  { id: 'clean-full',    label: 'Limpar toda a fila',Icon: Trash2,         color: 'red'   , confirm: true  },
]

const COLOR_MAP = {
  sky:    { bg: '#F0F9FF', border: '#BAE6FD', text: '#0369A1', hoverBg: '#E0F2FE' },
  amber:  { bg: '#FFFBEB', border: '#FDE68A', text: '#92400E', hoverBg: '#FEF3C7' },
  orange: { bg: '#FFF7ED', border: '#FED7AA', text: '#9A3412', hoverBg: '#FFEDD5' },
  red:    { bg: '#FEF2F2', border: '#FECACA', text: '#991B1B', hoverBg: '#FEE2E2' },
}

export default function ActionPanel({ onActionComplete, recommendedActions = [] }) {
  const toast                     = useToast()
  const [pending, setPending]     = useState(null)
  const [confirmId, setConfirmId] = useState(null)

  const execute = async (action) => {
    setConfirmId(null)
    setPending(action.id)
    try {
      const res = await runAction(action.id)
      toast({ type: 'ok', msg: res.message || `${action.label} concluído.` })
      onActionComplete?.()
    } catch (err) {
      toast({ type: 'err', msg: err?.response?.data?.detail || err.message || 'Erro ao executar.' })
    } finally {
      setPending(null)
    }
  }

  const confirmAction = ACTIONS.find((a) => a.id === confirmId)
  const hasRecommended = recommendedActions.length > 0

  return (
    <div className="card space-y-3">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span className="section-label">Ações</span>
        {hasRecommended && (
          <span style={{
            fontSize: 9, fontWeight: 700, letterSpacing: '0.08em',
            textTransform: 'uppercase', padding: '2px 7px', borderRadius: 999,
            background: '#F0F9FF', border: '1px solid #BAE6FD', color: '#0369A1',
          }}>
            {recommendedActions.length} sugerida{recommendedActions.length > 1 ? 's' : ''}
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {ACTIONS.map((action) => {
          const { Icon } = action
          const c = COLOR_MAP[action.color]
          const isRunning   = pending === action.id
          const isRecommended = recommendedActions.includes(action.id)
          return (
            <div key={action.id} style={{ position: 'relative' }}>
              <button
                disabled={!!pending}
                onClick={() => action.confirm ? setConfirmId(action.id) : execute(action)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  borderRadius: 8,
                  border: isRecommended
                    ? '2px solid #0EA5E9'
                    : `1px solid ${c.border}`,
                  padding: isRecommended ? '5px 11px' : '6px 12px',
                  fontSize: 11, fontWeight: isRecommended ? 600 : 500,
                  color: isRecommended ? '#0369A1' : c.text,
                  background: isRecommended ? '#EFF6FF' : c.bg,
                  cursor: pending ? 'not-allowed' : 'pointer',
                  transition: 'background 0.15s, opacity 0.15s',
                  opacity: !!pending && !isRunning ? 0.45 : 1,
                  boxShadow: isRecommended ? '0 0 0 3px rgba(14,165,233,0.12)' : 'none',
                }}
                onMouseEnter={e => { if (!pending) e.currentTarget.style.background = isRecommended ? '#DBEAFE' : c.hoverBg }}
                onMouseLeave={e => { e.currentTarget.style.background = isRecommended ? '#EFF6FF' : c.bg }}
              >
                <Icon size={12} style={{ animation: isRunning ? 'spin 1s linear infinite' : undefined }} />
                {isRunning ? 'Executando…' : action.label}
              </button>
              {/* Badge "Sugerido" */}
              {isRecommended && !isRunning && (
                <span style={{
                  position: 'absolute', top: -7, right: -4,
                  fontSize: 8, fontWeight: 700, letterSpacing: '0.05em',
                  padding: '1px 5px', borderRadius: 999,
                  background: '#0EA5E9', color: '#fff',
                  pointerEvents: 'none',
                }}>
                  Sugerido
                </span>
              )}
            </div>
          )
        })}
      </div>

      {confirmAction && (
        <div style={{
          borderRadius: 10, padding: '12px 14px',
          background: '#FEF2F2', border: '1px solid #FECACA',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <AlertTriangle size={13} color="#DC2626" />
            <span style={{ fontSize: 12, color: '#991B1B' }}>
              Confirma: <strong>{confirmAction.label}</strong>?
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => execute(confirmAction)}
              style={{
                borderRadius: 7, border: '1px solid #FECACA',
                padding: '5px 14px', fontSize: 11, fontWeight: 600,
                color: '#991B1B', background: '#FEE2E2', cursor: 'pointer',
              }}
              onMouseEnter={e => e.currentTarget.style.background = '#FECACA'}
              onMouseLeave={e => e.currentTarget.style.background = '#FEE2E2'}
            >
              Confirmar
            </button>
            <button
              onClick={() => setConfirmId(null)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                borderRadius: 7, border: '1px solid #E2E8F0',
                padding: '5px 14px', fontSize: 11, fontWeight: 500,
                color: 'var(--muted)', background: '#F8FAFC', cursor: 'pointer',
              }}
              onMouseEnter={e => e.currentTarget.style.background = '#F1F5F9'}
              onMouseLeave={e => e.currentTarget.style.background = '#F8FAFC'}
            >
              <X size={11} /> Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
