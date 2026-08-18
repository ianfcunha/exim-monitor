/**
 * Painel de ações — identidade AVILI light profissional.
 *
 * Ações simples (sem parâmetro): botão → confirmação → executa
 * Ações parametrizadas (block-ip, block-sender, clean-sender):
 *   botão → input inline → confirmação → executa
 */
import { AlertTriangle, Ban, CornerDownLeft, RotateCcw, Search, Shield, Snowflake, Trash2, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { runAction } from '../api/client'
import { Button } from '@/components/ui/button'
import { useToast } from '../contexts/ToastContext'

const ACTIONS = [
  { id: 'retry-queue',   label: 'Reprocessar fila',   Icon: RotateCcw,      color: 'sky',    confirm: false, param: null },
  { id: 'clean-frozen',  label: 'Remover frozen',      Icon: Snowflake,      color: 'amber',  confirm: true,  param: null },
  { id: 'clean-bounces', label: 'Limpar bounces',      Icon: CornerDownLeft, color: 'orange', confirm: true,  param: null },
  { id: 'clean-sender',  label: 'Limpar remetente',    Icon: Search,         color: 'purple', confirm: true,  param: 'email', placeholder: 'remetente@dominio.com' },
  { id: 'block-ip',      label: 'Bloquear IP',         Icon: Shield,         color: 'rose',   confirm: true,  param: 'ip',    placeholder: '192.168.0.1' },
  { id: 'block-sender',  label: 'Bloquear remetente',  Icon: Ban,            color: 'red',    confirm: true,  param: 'email', placeholder: 'spam@dominio.com' },
  { id: 'clean-full',    label: 'Limpar toda a fila',  Icon: Trash2,         color: 'red',    confirm: true,  param: null },
]

const COLOR_MAP = {
  sky:    { bg: '#F0F9FF', border: '#BAE6FD', text: '#0369A1', hoverBg: '#E0F2FE' },
  amber:  { bg: '#FFFBEB', border: '#FDE68A', text: '#92400E', hoverBg: '#FEF3C7' },
  orange: { bg: '#FFF7ED', border: '#FED7AA', text: '#9A3412', hoverBg: '#FFEDD5' },
  purple: { bg: '#FAF5FF', border: '#E9D5FF', text: '#6B21A8', hoverBg: '#F3E8FF' },
  rose:   { bg: '#FFF1F2', border: '#FECDD3', text: '#9F1239', hoverBg: '#FFE4E6' },
  red:    { bg: '#FEF2F2', border: '#FECACA', text: '#991B1B', hoverBg: '#FEE2E2' },
}

export default function ActionPanel({ onActionComplete, recommendedActions = [] }) {
  const toast                       = useToast()
  const [pending, setPending]       = useState(null)
  const [confirmId, setConfirmId]   = useState(null)
  const [paramValue, setParamValue] = useState('')
  const [paramError, setParamError] = useState('')
  const inputRef                    = useRef(null)

  const hasRecommended = recommendedActions.length > 0

  const requestAction = (action) => {
    setParamValue('')
    setParamError('')
    setConfirmId(action.id)
    if (action.param) setTimeout(() => inputRef.current?.focus(), 50)
  }

  const validateParam = (action, value) => {
    if (!action.param) return true
    const v = value.trim()
    if (!v) { setParamError('Campo obrigatório'); return false }
    if (action.param === 'ip') {
      const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(v)
      const ipv6 = /^[0-9a-fA-F:]+$/.test(v) && v.includes(':')
      if (!ipv4 && !ipv6) { setParamError('IP inválido (ex: 192.168.0.1)'); return false }
    }
    if (action.param === 'email') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { setParamError('Endereço inválido'); return false }
    }
    return true
  }

  const execute = async (action) => {
    const param = action.param ? paramValue.trim() : null
    if (!validateParam(action, paramValue)) return
    setConfirmId(null)
    setPending(action.id)
    try {
      const res = await runAction(action.id, param)
      toast({ type: 'ok', msg: res.message || `${action.label} concluído.` })
      onActionComplete?.()
    } catch (err) {
      toast({ type: 'err', msg: err?.response?.data?.detail || err.message || 'Erro ao executar.' })
    } finally {
      setPending(null)
    }
  }

  const cancel = () => { setConfirmId(null); setParamValue(''); setParamError('') }

  const confirmAction = ACTIONS.find((a) => a.id === confirmId)

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
          const isRunning     = pending === action.id
          const isRecommended = recommendedActions.includes(action.id)
          return (
            <div key={action.id} style={{ position: 'relative' }}>
              <button
                disabled={!!pending}
                onClick={() => requestAction(action)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  borderRadius: 8,
                  border: isRecommended ? '2px solid #0EA5E9' : `1px solid ${c.border}`,
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
              {isRecommended && !isRunning && (
                <span style={{
                  position: 'absolute', top: -7, right: -4,
                  fontSize: 8, fontWeight: 700, letterSpacing: '0.05em',
                  padding: '1px 5px', borderRadius: 999,
                  background: '#0EA5E9', color: '#fff', pointerEvents: 'none',
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

          {confirmAction.param && (
            <div style={{ marginBottom: 10 }}>
              <input
                ref={inputRef}
                type="text"
                value={paramValue}
                placeholder={confirmAction.placeholder || ''}
                onChange={e => { setParamValue(e.target.value); setParamError('') }}
                onKeyDown={e => e.key === 'Enter' && execute(confirmAction)}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  borderRadius: 7,
                  border: `1px solid ${paramError ? '#F87171' : '#FECACA'}`,
                  padding: '6px 10px', fontSize: 12, color: '#1E293B',
                  background: '#FFF', outline: 'none',
                  boxShadow: paramError ? '0 0 0 2px rgba(248,113,113,0.25)' : 'none',
                }}
              />
              {paramError && (
                <span style={{ fontSize: 10, color: '#DC2626', marginTop: 3, display: 'block' }}>
                  {paramError}
                </span>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => execute(confirmAction)}
              className="border-transparent bg-red-600 text-white shadow-sm hover:bg-red-700 hover:text-white active:bg-red-800"
            >
              Confirmar
            </Button>
            <Button variant="outline" size="sm" onClick={cancel}>
              <X size={11} /> Cancelar
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
