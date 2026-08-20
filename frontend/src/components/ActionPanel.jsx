/**
 * Painel de ações — identidade AVILI light profissional.
 *
 * Ações simples (sem parâmetro): botão → confirmação → executa
 * Ações parametrizadas (block-ip, block-sender, clean-sender):
 *   botão → input inline → confirmação → executa
 */
import { AlertTriangle, Ban, CornerDownLeft, RotateCcw, Search, Shield, Snowflake, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { runAction } from '../api/client'
import { Button } from '@/components/ui/button'
import { useToast } from '../contexts/ToastContext'
import { useServer } from '../contexts/ServerContext'

// Ações que suportam before_snapshot no diag-exim.sh (Sessão 2, Item 1) —
// só essas mostram o checkbox de captura de estado antes de confirmar.
const SNAPSHOT_ACTIONS = new Set([
  'clean-full', 'clean-frozen', 'clean-bounces', 'clean-sender', 'clean-auth',
  'block-ip', 'block-sender',
])

const ACTIONS = [
  { id: 'retry-queue',   label: 'Reprocessar fila',   Icon: RotateCcw,      color: 'sky',    confirm: false, param: null },
  { id: 'clean-frozen',  label: 'Remover frozen',      Icon: Snowflake,      color: 'amber',  confirm: true,  param: null },
  { id: 'clean-bounces', label: 'Limpar bounces',      Icon: CornerDownLeft, color: 'orange', confirm: true,  param: null },
  { id: 'clean-sender',  label: 'Limpar remetente',    Icon: Search,         color: 'purple', confirm: true,  param: 'email', placeholder: 'remetente@dominio.com' },
  { id: 'block-ip',      label: 'Bloquear IP',         Icon: Shield,         color: 'rose',   confirm: true,  param: 'ip',    placeholder: '192.168.0.1' },
  { id: 'block-sender',  label: 'Bloquear remetente',  Icon: Ban,            color: 'red',    confirm: true,  param: 'email', placeholder: 'spam@dominio.com' },
  { id: 'clean-full',    label: 'Limpar toda a fila',  Icon: Trash2,         color: 'red',    confirm: true,  param: null },
]

// Tons por categoria de ação — bg/border misturados com var(--card)/var(--border)
// (não um hex sólido) e text misturado com var(--text), pra se adaptar ao tema
// escuro automaticamente em vez de ficar pastel-claro fixo (ilegível no escuro).
const COLOR_MAP = {
  sky:    { bg: 'var(--accent-bg)', border: 'var(--accent-border)', text: 'var(--accent-fg)', hoverBg: 'color-mix(in srgb, var(--sky) 18%, var(--card))' },
  amber:  { bg: 'var(--warn-bg)', border: 'var(--warn-border)', text: 'var(--warn)', hoverBg: 'color-mix(in srgb, var(--warn) 22%, var(--card))' },
  orange: { bg: 'color-mix(in srgb, #EA580C 12%, var(--card))', border: 'color-mix(in srgb, #EA580C 35%, var(--border))', text: 'color-mix(in srgb, #EA580C 70%, var(--text))', hoverBg: 'color-mix(in srgb, #EA580C 22%, var(--card))' },
  purple: { bg: 'color-mix(in srgb, #A855F7 12%, var(--card))', border: 'color-mix(in srgb, #A855F7 35%, var(--border))', text: 'color-mix(in srgb, #A855F7 70%, var(--text))', hoverBg: 'color-mix(in srgb, #A855F7 22%, var(--card))' },
  rose:   { bg: 'color-mix(in srgb, #E11D48 12%, var(--card))', border: 'color-mix(in srgb, #E11D48 35%, var(--border))', text: 'color-mix(in srgb, #E11D48 70%, var(--text))', hoverBg: 'color-mix(in srgb, #E11D48 22%, var(--card))' },
  red:    { bg: 'var(--danger-bg)', border: 'var(--danger-border)', text: 'var(--danger)', hoverBg: 'color-mix(in srgb, var(--danger) 22%, var(--card))' },
}

export default function ActionPanel({ onActionComplete, recommendedActions = [] }) {
  const toast                       = useToast()
  const { activeServer }            = useServer()
  const [pending, setPending]       = useState(null)
  const [confirmId, setConfirmId]   = useState(null)
  const [paramValue, setParamValue] = useState('')
  const [paramError, setParamError] = useState('')
  const [snapshot, setSnapshot]     = useState(true)
  const inputRef                    = useRef(null)
  const cancelBtnRef                = useRef(null)

  const hasRecommended = recommendedActions.length > 0

  const requestAction = (action) => {
    setParamValue('')
    setParamError('')
    setSnapshot(true)
    setConfirmId(action.id)
    // Move o foco pro dentro do painel de confirmação assim que ele
    // aparece — sem isso, numa ação sem parâmetro o foco fica parado no
    // botão que acabou de ser clicado (que fica ACIMA do painel na
    // ordem do DOM), então Tab pularia o Confirmar/Cancelar e iria pro
    // próximo botão de ação. Foco vai pro Cancelar por padrão (não pro
    // Confirmar) — é uma ação destrutiva, não queremos que um Enter
    // repetido dispare a execução sem o usuário decidir conscientemente.
    setTimeout(() => (action.param ? inputRef : cancelBtnRef).current?.focus(), 50)
  }

  // Esc cancela a confirmação de onde quer que o foco esteja dentro dela
  // (não só quando o foco está estritamente no painel) — o painel é uma
  // div inline, não um <dialog>/Radix Dialog com Esc nativo.
  useEffect(() => {
    if (!confirmId) return
    const onKeyDown = (e) => { if (e.key === 'Escape') cancel() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmId])

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
      const res = await runAction(action.id, param, activeServer?.id ?? null, snapshot)
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
            background: 'var(--accent-bg)', border: '1px solid var(--accent-border)', color: 'var(--accent-fg)',
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
                  border: isRecommended ? '2px solid var(--sky)' : `1px solid ${c.border}`,
                  padding: isRecommended ? '5px 11px' : '6px 12px',
                  fontSize: 11, fontWeight: isRecommended ? 600 : 500,
                  color: isRecommended ? 'var(--accent-fg)' : c.text,
                  background: isRecommended ? 'var(--accent-bg)' : c.bg,
                  cursor: pending ? 'not-allowed' : 'pointer',
                  transition: 'background 0.15s, opacity 0.15s',
                  opacity: !!pending && !isRunning ? 0.45 : 1,
                  boxShadow: isRecommended ? '0 0 0 3px rgba(14,165,233,0.12)' : 'none',
                }}
                onMouseEnter={e => { if (!pending) e.currentTarget.style.background = isRecommended ? 'color-mix(in srgb, var(--sky) 22%, var(--card))' : c.hoverBg }}
                onMouseLeave={e => { e.currentTarget.style.background = isRecommended ? 'var(--accent-bg)' : c.bg }}
              >
                <Icon size={12} style={{ animation: isRunning ? 'spin 1s linear infinite' : undefined }} />
                {isRunning ? 'Executando…' : action.label}
              </button>
              {isRecommended && !isRunning && (
                <span style={{
                  position: 'absolute', top: -7, right: -4,
                  fontSize: 8, fontWeight: 700, letterSpacing: '0.05em',
                  padding: '1px 5px', borderRadius: 999,
                  background: 'var(--sky)', color: '#fff', pointerEvents: 'none',
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
          background: 'var(--danger-bg)', border: '1px solid var(--danger-border)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <AlertTriangle size={13} color="var(--danger)" />
            <span style={{ fontSize: 12, color: 'var(--danger)' }}>
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
                  border: `1px solid ${paramError ? 'var(--danger)' : 'var(--danger-border)'}`,
                  padding: '6px 10px', fontSize: 12, color: 'var(--text)',
                  background: 'var(--card)', outline: 'none',
                  boxShadow: paramError ? '0 0 0 2px rgba(248,113,113,0.25)' : 'none',
                  transition: 'border-color 0.15s, box-shadow 0.15s',
                }}
                onFocus={e => {
                  e.target.style.borderColor = paramError ? 'var(--danger)' : 'var(--sky)'
                  e.target.style.boxShadow = paramError
                    ? '0 0 0 3px rgba(248,113,113,0.30)'
                    : '0 0 0 3px rgba(14,165,233,0.20)'
                }}
                onBlur={e => {
                  e.target.style.borderColor = paramError ? 'var(--danger)' : 'var(--danger-border)'
                  e.target.style.boxShadow = paramError ? '0 0 0 2px rgba(248,113,113,0.25)' : 'none'
                }}
              />
              {paramError && (
                <span style={{ fontSize: 10, color: 'var(--danger)', marginTop: 3, display: 'block' }}>
                  {paramError}
                </span>
              )}
            </div>
          )}

          {SNAPSHOT_ACTIONS.has(confirmAction.id) && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, fontSize: 11, color: 'var(--danger)', cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={snapshot}
                onChange={e => setSnapshot(e.target.checked)}
                style={{ width: 13, height: 13, accentColor: 'var(--danger)' }}
              />
              Registrar o estado atual antes de executar (recomendado)
            </label>
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
            <Button ref={cancelBtnRef} variant="outline" size="sm" onClick={cancel}>
              <X size={11} /> Cancelar
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
