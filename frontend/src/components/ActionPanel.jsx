/**
 * Painel de ações — identidade AVILI light.
 * Botões ghost com borda sky/amber/red, toasts globais, ícones Lucide.
 */
import { AlertTriangle, CornerDownLeft, RotateCcw, Snowflake, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { runAction } from '../api/client'
import { useToast } from '../contexts/ToastContext'

const ACTIONS = [
  { id: 'retry-queue',   label: 'Forçar reprocessamento', Icon: RotateCcw,      color: 'sky'    , confirm: false },
  { id: 'clean-frozen',  label: 'Remover frozen',          Icon: Snowflake,      color: 'amber'  , confirm: true  },
  { id: 'clean-bounces', label: 'Limpar bounces',           Icon: CornerDownLeft, color: 'orange' , confirm: true  },
  { id: 'clean-full',    label: 'Limpar TODA a fila',       Icon: Trash2,         color: 'red'    , confirm: true  },
]

const COLOR_MAP = {
  sky:    { border: 'rgba(14,165,233,0.40)',  text: '#0369A1', hover: 'rgba(14,165,233,0.08)'  },
  amber:  { border: 'rgba(251,191,36,0.45)',  text: '#B45309', hover: 'rgba(251,191,36,0.08)'  },
  orange: { border: 'rgba(249,115,22,0.40)',  text: '#C2410C', hover: 'rgba(249,115,22,0.08)'  },
  red:    { border: 'rgba(239,68,68,0.40)',   text: '#DC2626', hover: 'rgba(239,68,68,0.08)'   },
}

export default function ActionPanel({ onActionComplete }) {
  const toast                     = useToast()
  const [pending, setPending]     = useState(null)
  const [confirmId, setConfirmId] = useState(null)

  const execute = async (action) => {
    setConfirmId(null)
    setPending(action.id)
    try {
      const res = await runAction(action.id)
      toast({ type: 'ok',  msg: res.message || `${action.label} concluído.` })
      onActionComplete?.()
    } catch (err) {
      toast({ type: 'err', msg: err?.response?.data?.detail || err.message || 'Erro ao executar ação.' })
    } finally {
      setPending(null)
    }
  }

  const confirmAction = ACTIONS.find((a) => a.id === confirmId)

  return (
    <div className="card space-y-3">
      <span className="section-label">Ações</span>

      <div className="flex flex-wrap gap-2">
        {ACTIONS.map((action) => {
          const { Icon } = action
          const c = COLOR_MAP[action.color]
          const isRunning = pending === action.id
          return (
            <button
              key={action.id}
              disabled={!!pending}
              onClick={() => action.confirm ? setConfirmId(action.id) : execute(action)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                borderRadius: 10, border: `1px solid ${c.border}`,
                padding: '6px 12px', fontSize: 11, fontWeight: 500,
                color: c.text, background: 'transparent', cursor: 'pointer',
                transition: 'background 0.15s, opacity 0.15s',
                opacity: !!pending && !isRunning ? 0.4 : 1,
              }}
              onMouseEnter={e => { if (!pending) e.currentTarget.style.background = c.hover }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
            >
              <Icon size={12} style={{ animation: isRunning ? 'spin 1s linear infinite' : undefined }} />
              {isRunning ? 'Executando…' : action.label}
            </button>
          )
        })}
      </div>

      {/* Modal de confirmação */}
      {confirmAction && (
        <div
          style={{
            borderRadius: 12, padding: '12px 14px',
            background: 'rgba(239,68,68,0.07)',
            border: '1px solid rgba(239,68,68,0.28)',
            backdropFilter: 'blur(8px)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <AlertTriangle size={13} color="#DC2626" />
            <span style={{ fontSize: 12, color: '#DC2626' }}>
              Confirma: <strong>{confirmAction.label}</strong>?
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => execute(confirmAction)}
              style={{
                borderRadius: 8, border: '1px solid rgba(239,68,68,0.40)',
                padding: '5px 14px', fontSize: 11, fontWeight: 500,
                color: '#DC2626', background: 'transparent', cursor: 'pointer',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(239,68,68,0.08)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              Confirmar
            </button>
            <button
              onClick={() => setConfirmId(null)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                borderRadius: 8, border: '1px solid rgba(15,26,46,0.15)',
                padding: '5px 14px', fontSize: 11, fontWeight: 500,
                color: 'var(--muted)', background: 'transparent', cursor: 'pointer',
                transition: 'background 0.15s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'rgba(15,26,46,0.04)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <X size={11} /> Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
