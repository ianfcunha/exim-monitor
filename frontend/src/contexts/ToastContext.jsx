/**
 * Toast global — identidade AVILI light.
 * toast({ type: 'ok' | 'err', msg: '...' })
 */
import { CheckCircle2, X, XCircle } from 'lucide-react'
import { createContext, useCallback, useContext, useState } from 'react'

const ToastContext = createContext(null)
let _id = 0

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const add = useCallback(({ type = 'ok', msg, duration = 4500 }) => {
    const id = ++_id
    setToasts((p) => [...p, { id, type, msg }])
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), duration)
  }, [])

  const remove = useCallback((id) => setToasts((p) => p.filter((t) => t.id !== id)), [])

  return (
    <ToastContext.Provider value={add}>
      {children}
      <ToastStack toasts={toasts} onRemove={remove} />
    </ToastContext.Provider>
  )
}

function ToastStack({ toasts, onRemove }) {
  if (!toasts.length) return null
  return (
    <div
      aria-live="polite"
      style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none' }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => onRemove(t.id)}
          className="animate-toast-in"
          style={{
            pointerEvents: 'auto',
            display: 'flex', alignItems: 'center', gap: 10,
            minWidth: 260, maxWidth: 380,
            borderRadius: 14, padding: '11px 16px',
            fontSize: 13, fontWeight: 400, cursor: 'pointer',
            backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
            boxShadow: '0 8px 32px rgba(14,100,180,0.15)',
            ...(t.type === 'ok'
              ? { background: 'rgba(255,255,255,0.90)', border: '1px solid rgba(14,165,233,0.28)', color: '#0369A1' }
              : { background: 'rgba(255,255,255,0.90)', border: '1px solid rgba(239,68,68,0.30)',  color: '#DC2626' }
            ),
          }}
        >
          {t.type === 'ok'
            ? <CheckCircle2 size={15} style={{ flexShrink: 0, color: '#0EA5E9' }} />
            : <XCircle      size={15} style={{ flexShrink: 0, color: '#DC2626' }} />
          }
          <span style={{ flex: 1, lineHeight: 1.4, color: '#0F1A2E' }}>{t.msg}</span>
          <X size={13} style={{ flexShrink: 0, opacity: 0.35, color: '#0F1A2E' }} />
        </div>
      ))}
    </div>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast deve ser usado dentro de <ToastProvider>')
  return ctx
}
