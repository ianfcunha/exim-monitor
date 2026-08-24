/**
 * Toast global — identidade AVILI light.
 * Escuta o evento customizado `api:rate-limited` disparado pelo client.js
 * para exibir aviso de 429 automaticamente em qualquer tela.
 */
import { CheckCircle2, X, XCircle } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useState } from 'react'

const ToastContext = createContext(null)
let _id = 0

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const add = useCallback(({ type = 'ok', msg, duration = 4500 }) => {
    const id = ++_id
    setToasts(p => [...p, { id, type, msg }])
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), duration)
  }, [])

  const remove = useCallback((id) => setToasts(p => p.filter(t => t.id !== id)), [])

  // Captura 429 disparado pelo interceptor do Axios
  useEffect(() => {
    const handler = (e) => add({ type: 'error', msg: e.detail?.msg ?? 'Muitas requisições. Aguarde um momento.', duration: 6000 })
    window.addEventListener('api:rate-limited', handler)
    return () => window.removeEventListener('api:rate-limited', handler)
  }, [add])

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
      {toasts.map(t => (
        <div
          key={t.id}
          onClick={() => onRemove(t.id)}
          className="animate-toast-in"
          style={{
            pointerEvents: 'auto',
            display: 'flex', alignItems: 'center', gap: 10,
            minWidth: 260, maxWidth: 380,
            borderRadius: 12, padding: '11px 16px',
            fontSize: 13, fontWeight: 400, cursor: 'pointer',
            background: 'var(--card)',
            border: t.type === 'ok' ? '1px solid var(--accent-border)' : '1px solid var(--danger-border)',
            boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
            color: t.type === 'ok' ? 'var(--accent-fg)' : 'var(--danger)',
          }}
        >
          {t.type === 'ok'
            ? <CheckCircle2 size={15} style={{ flexShrink: 0, color: 'var(--sky)' }} />
            : <XCircle      size={15} style={{ flexShrink: 0, color: 'var(--danger)' }} />
          }
          <span style={{ flex: 1, lineHeight: 1.4, color: 'var(--text)' }}>{t.msg}</span>
          <X size={13} style={{ flexShrink: 0, opacity: 0.35, color: 'var(--text)' }} />
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
