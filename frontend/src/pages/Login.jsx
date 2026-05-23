/**
 * Página de login — identidade AVILI light.
 * Logo SVG inline com traços escuros, glass card branco, paleta sky-blue.
 */
import { useState } from 'react'
import { login } from '../api/client'

function LogoMark({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 60 60" fill="none" aria-hidden>
      <path d="M10 46 L30 16 L50 46" fill="none" stroke="#0F1A2E" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M18 36 L30 26 L42 36" fill="none" stroke="#0EA5E9" strokeWidth="3"   strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="30" cy="16" r="2.5" fill="#22D3EE"/>
    </svg>
  )
}

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState(null)
  const [loading, setLoading]   = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const data = await login(username, password)
      onLogin(data.access_token)
    } catch (err) {
      setError(err?.response?.data?.detail || 'Falha ao conectar com a API.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '0 16px',
        background: '#EEF2F7',
        backgroundImage: `
          radial-gradient(ellipse 700px 500px at 20% 10%, rgba(14,165,233,0.18) 0%, transparent 65%),
          radial-gradient(ellipse 500px 400px at 85% 90%, rgba(34,211,238,0.14) 0%, transparent 60%)
        `,
        backgroundAttachment: 'fixed',
      }}
    >
      <div style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 28 }}>

        {/* Logo + título */}
        <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: 60, height: 60, borderRadius: 18,
            background: 'rgba(255,255,255,0.80)',
            border: '1px solid rgba(14,165,233,0.22)',
            boxShadow: '0 4px 20px rgba(14,100,180,0.12)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <LogoMark size={32} />
          </div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '0.06em', color: '#0F1A2E', margin: 0 }}>
              EXIM Monitor
            </h1>
            <p style={{ fontSize: 10, letterSpacing: '0.28em', textTransform: 'uppercase', color: '#0EA5E9', marginTop: 5, fontWeight: 500 }}>
              Um produto de Avili
            </p>
          </div>
        </div>

        {/* Card glass */}
        <form
          onSubmit={handleSubmit}
          style={{
            background: 'rgba(255,255,255,0.70)',
            border: '1px solid rgba(255,255,255,0.90)',
            borderRadius: 20,
            padding: '28px 24px',
            backdropFilter: 'blur(24px)',
            WebkitBackdropFilter: 'blur(24px)',
            boxShadow: '0 8px 40px rgba(14,100,180,0.12), 0 1px 3px rgba(14,100,180,0.06), inset 0 1px 0 rgba(255,255,255,0.98)',
            display: 'flex', flexDirection: 'column', gap: 16,
          }}
        >
          {/* Campo usuário */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label
              htmlFor="username"
              style={{ fontSize: 10, letterSpacing: '0.28em', textTransform: 'uppercase', color: '#0EA5E9', fontWeight: 600 }}
            >
              Usuário
            </label>
            <input
              id="username"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              placeholder="admin"
              style={{
                width: '100%', borderRadius: 10,
                background: 'rgba(14,165,233,0.05)',
                border: '1px solid rgba(14,165,233,0.22)',
                padding: '10px 14px', fontSize: 13,
                color: '#0F1A2E', outline: 'none',
                transition: 'border-color 0.15s',
              }}
              onFocus={e => e.target.style.borderColor = 'rgba(14,165,233,0.55)'}
              onBlur={e  => e.target.style.borderColor = 'rgba(14,165,233,0.22)'}
            />
          </div>

          {/* Campo senha */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label
              htmlFor="password"
              style={{ fontSize: 10, letterSpacing: '0.28em', textTransform: 'uppercase', color: '#0EA5E9', fontWeight: 600 }}
            >
              Senha
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder="••••••••"
              style={{
                width: '100%', borderRadius: 10,
                background: 'rgba(14,165,233,0.05)',
                border: '1px solid rgba(14,165,233,0.22)',
                padding: '10px 14px', fontSize: 13,
                color: '#0F1A2E', outline: 'none',
                transition: 'border-color 0.15s',
              }}
              onFocus={e => e.target.style.borderColor = 'rgba(14,165,233,0.55)'}
              onBlur={e  => e.target.style.borderColor = 'rgba(14,165,233,0.22)'}
            />
          </div>

          {/* Erro */}
          {error && (
            <div style={{
              borderRadius: 10, padding: '10px 14px', fontSize: 12,
              background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.28)',
              color: '#DC2626',
            }}>
              {error}
            </div>
          )}

          {/* Botão primário */}
          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%', borderRadius: 10, border: 'none',
              background: loading ? 'rgba(14,165,233,0.55)' : '#0EA5E9',
              color: 'white', fontSize: 13, fontWeight: 600,
              letterSpacing: '0.05em', padding: '11px',
              cursor: loading ? 'not-allowed' : 'pointer',
              transition: 'background 0.15s',
              boxShadow: '0 2px 12px rgba(14,165,233,0.30)',
            }}
            onMouseEnter={e => { if (!loading) e.currentTarget.style.background = '#0284C7' }}
            onMouseLeave={e => { if (!loading) e.currentTarget.style.background = '#0EA5E9' }}
          >
            {loading ? 'Entrando…' : 'Entrar'}
          </button>
        </form>

      </div>
    </div>
  )
}
