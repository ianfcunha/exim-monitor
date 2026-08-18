/**
 * Página de login — identidade AVILI light profissional.
 */
import { useState } from 'react'
import { login } from '../api/client'
import { Button } from '@/components/ui/button'

function LogoMark({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 60 60" fill="none" aria-hidden>
      <path d="M10 46 L30 16 L50 46" fill="none" stroke="#0F172A" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M18 36 L30 26 L42 36" fill="none" stroke="#0EA5E9" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="30" cy="16" r="2.5" fill="#22D3EE"/>
    </svg>
  )
}

const inputStyle = {
  width: '100%', borderRadius: 8,
  background: '#F8FAFC',
  border: '1px solid #E2E8F0',
  padding: '10px 14px', fontSize: 13,
  color: '#0F172A', outline: 'none',
  transition: 'border-color 0.15s, box-shadow 0.15s',
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
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '0 16px', background: '#F1F5F9',
      backgroundImage: `
        radial-gradient(ellipse 700px 500px at 15% 15%, rgba(14,165,233,0.10) 0%, transparent 60%),
        radial-gradient(ellipse 600px 400px at 85% 85%, rgba(34,211,238,0.07) 0%, transparent 55%)
      `,
      backgroundAttachment: 'fixed',
    }}>
      <div style={{ width: '100%', maxWidth: 380 }}>

        {/* Logo + título */}
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{
            width: 64, height: 64, borderRadius: 18, margin: '0 auto 14px',
            background: '#fff', border: '1px solid #E2E8F0',
            boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <LogoMark size={34} />
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, letterSpacing: '-0.01em' }}>
            <span style={{ color: '#0F172A' }}>Mail </span>
            <span style={{ color: '#0EA5E9' }}>IQ</span>
          </h1>
          <p style={{ fontSize: 10, letterSpacing: '0.24em', textTransform: 'uppercase', color: '#94A3B8', marginTop: 5, fontWeight: 600 }}>
            by <span style={{ color: '#0EA5E9' }}>AVILI</span>
          </p>
        </div>

        {/* Card */}
        <div style={{
          background: '#fff', border: '1px solid #E2E8F0', borderRadius: 16,
          padding: '28px 24px',
          boxShadow: '0 4px 24px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)',
        }}>
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label htmlFor="username" style={{ fontSize: 11, fontWeight: 600, color: '#64748B', letterSpacing: '0.05em' }}>
                Usuário
              </label>
              <input
                id="username" type="text" autoComplete="username"
                value={username} onChange={e => setUsername(e.target.value)}
                required placeholder="admin"
                style={inputStyle}
                onFocus={e => { e.target.style.borderColor = '#0EA5E9'; e.target.style.boxShadow = '0 0 0 3px rgba(14,165,233,0.10)' }}
                onBlur={e  => { e.target.style.borderColor = '#E2E8F0'; e.target.style.boxShadow = 'none' }}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label htmlFor="password" style={{ fontSize: 11, fontWeight: 600, color: '#64748B', letterSpacing: '0.05em' }}>
                Senha
              </label>
              <input
                id="password" type="password" autoComplete="current-password"
                value={password} onChange={e => setPassword(e.target.value)}
                required placeholder="••••••••"
                style={inputStyle}
                onFocus={e => { e.target.style.borderColor = '#0EA5E9'; e.target.style.boxShadow = '0 0 0 3px rgba(14,165,233,0.10)' }}
                onBlur={e  => { e.target.style.borderColor = '#E2E8F0'; e.target.style.boxShadow = 'none' }}
              />
            </div>

            {error && (
              <div style={{
                borderRadius: 8, padding: '9px 12px', fontSize: 12,
                background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B',
              }}>
                {error}
              </div>
            )}

            <Button type="submit" disabled={loading} size="lg" className="w-full font-bold">
              {loading ? 'Entrando…' : 'Entrar'}
            </Button>
          </form>
        </div>

      </div>
    </div>
  )
}
