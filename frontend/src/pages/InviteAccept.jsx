/**
 * InviteAccept — página acessada via /invite/:token
 * O convidado define username e senha para ativar sua conta.
 */
import { useEffect, useState } from 'react'
import { acceptInvite, checkInvite } from '../api/client'

function LogoMark({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 60 60" fill="none" aria-hidden>
      <path d="M10 46 L30 16 L50 46" fill="none" stroke="#0F172A" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M18 36 L30 26 L42 36" fill="none" stroke="#0EA5E9" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="30" cy="16" r="2.5" fill="#22D3EE"/>
    </svg>
  )
}

const inputStyle = {
  width: '100%', padding: '10px 13px', borderRadius: 8, fontSize: 13,
  border: '1px solid #E2E8F0', outline: 'none', color: '#0F172A',
  background: '#F8FAFC', boxSizing: 'border-box',
  transition: 'border-color 0.15s, box-shadow 0.15s',
}

export default function InviteAccept({ token, onDone }) {
  const [info, setInfo]       = useState(null)   // { email, role }
  const [checking, setChecking] = useState(true)
  const [expired, setExpired]  = useState(false)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [saving, setSaving]    = useState(false)
  const [error, setError]      = useState(null)
  const [done, setDone]        = useState(false)

  useEffect(() => {
    checkInvite(token)
      .then(setInfo)
      .catch(e => {
        if (e?.response?.status === 410) setExpired(true)
        else setError(e?.response?.data?.detail ?? 'Token inválido.')
      })
      .finally(() => setChecking(false))
  }, [token])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError(null)
    if (password !== password2) { setError('As senhas não coincidem.'); return }
    if (password.length < 8)    { setError('A senha deve ter pelo menos 8 caracteres.'); return }

    setSaving(true)
    try {
      await acceptInvite(token, { username, password })
      setDone(true)
    } catch (e) {
      setError(e?.response?.data?.detail ?? 'Erro ao ativar conta.')
    } finally {
      setSaving(false)
    }
  }

  const card = (children) => (
    <div style={{ minHeight: '100vh', background: '#F1F5F9', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ width: '100%', maxWidth: 420, background: '#fff', borderRadius: 16, border: '1px solid #E2E8F0', boxShadow: '0 4px 24px rgba(0,0,0,0.07)', overflow: 'hidden' }}>
        <div style={{ padding: '24px 28px 0', display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
          <div style={{ width: 40, height: 40, borderRadius: 10, background: '#F0F9FF', border: '1px solid #BAE6FD', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <LogoMark />
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 800 }}>
              <span style={{ color: '#0F172A' }}>Mail </span>
              <span style={{ color: '#0EA5E9' }}>IQ</span>
            </div>
            <div style={{ fontSize: 9, letterSpacing: '0.18em', textTransform: 'uppercase', color: '#94A3B8', fontWeight: 600 }}>
              by <span style={{ color: '#0EA5E9' }}>AVILI</span>
            </div>
          </div>
        </div>
        <div style={{ padding: '0 28px 28px' }}>
          {children}
        </div>
      </div>
    </div>
  )

  if (checking) return card(
    <div style={{ textAlign: 'center', color: '#94A3B8', fontSize: 13, padding: '20px 0' }}>
      Verificando convite…
    </div>
  )

  if (expired) return card(
    <>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: '#0F172A', marginBottom: 8 }}>Convite expirado</h2>
      <p style={{ fontSize: 13, color: '#64748B' }}>
        Este link de convite expirou. Peça ao administrador que envie um novo convite.
      </p>
    </>
  )

  if (error && !info) return card(
    <>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: '#0F172A', marginBottom: 8 }}>Link inválido</h2>
      <p style={{ fontSize: 13, color: '#64748B' }}>{error}</p>
    </>
  )

  if (done) return card(
    <>
      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        <div style={{ width: 48, height: 48, borderRadius: '50%', background: '#F0FDF4', border: '1px solid #BBF7D0', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
          <span style={{ fontSize: 22 }}>✓</span>
        </div>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: '#0F172A', marginBottom: 6 }}>Conta ativada!</h2>
        <p style={{ fontSize: 13, color: '#64748B', marginBottom: 20 }}>
          Sua conta foi criada com sucesso. Faça login para continuar.
        </p>
        <button
          onClick={onDone}
          style={{ padding: '10px 24px', borderRadius: 8, fontSize: 13, fontWeight: 700, border: 'none', background: '#0EA5E9', color: '#fff', cursor: 'pointer' }}>
          Ir para o login
        </button>
      </div>
    </>
  )

  return card(
    <>
      <h2 style={{ fontSize: 16, fontWeight: 700, color: '#0F172A', marginBottom: 4 }}>
        Ativar conta
      </h2>
      <p style={{ fontSize: 12, color: '#64748B', marginBottom: 20 }}>
        Você foi convidado como <strong>{info?.role === 'admin' ? 'Administrador' : 'Visualizador'}</strong>
        {' '}com o e-mail <strong>{info?.email}</strong>.
        Escolha um nome de usuário e senha para continuar.
      </p>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#64748B', marginBottom: 5 }}>
            Nome de usuário
          </label>
          <input
            type="text" value={username} onChange={e => setUsername(e.target.value)}
            placeholder="seunome" required minLength={3} maxLength={50}
            style={inputStyle}
            onFocus={e => { e.target.style.borderColor = '#0EA5E9'; e.target.style.boxShadow = '0 0 0 3px rgba(14,165,233,0.10)' }}
            onBlur={e  => { e.target.style.borderColor = '#E2E8F0'; e.target.style.boxShadow = 'none' }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#64748B', marginBottom: 5 }}>
            Senha
          </label>
          <input
            type="password" value={password} onChange={e => setPassword(e.target.value)}
            placeholder="Mínimo 8 caracteres" required minLength={8}
            style={inputStyle}
            onFocus={e => { e.target.style.borderColor = '#0EA5E9'; e.target.style.boxShadow = '0 0 0 3px rgba(14,165,233,0.10)' }}
            onBlur={e  => { e.target.style.borderColor = '#E2E8F0'; e.target.style.boxShadow = 'none' }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#64748B', marginBottom: 5 }}>
            Confirmar senha
          </label>
          <input
            type="password" value={password2} onChange={e => setPassword2(e.target.value)}
            placeholder="Repita a senha" required
            style={inputStyle}
            onFocus={e => { e.target.style.borderColor = '#0EA5E9'; e.target.style.boxShadow = '0 0 0 3px rgba(14,165,233,0.10)' }}
            onBlur={e  => { e.target.style.borderColor = '#E2E8F0'; e.target.style.boxShadow = 'none' }}
          />
        </div>

        {error && (
          <div style={{ padding: '8px 12px', borderRadius: 8, background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B', fontSize: 12 }}>
            {error}
          </div>
        )}

        <button
          type="submit" disabled={saving}
          style={{
            padding: '11px 0', borderRadius: 8, fontSize: 13, fontWeight: 700,
            border: 'none', background: saving ? '#7DD3F0' : '#0EA5E9',
            color: '#fff', cursor: saving ? 'not-allowed' : 'pointer',
            marginTop: 4,
          }}>
          {saving ? 'Ativando…' : 'Ativar conta'}
        </button>
      </form>
    </>
  )
}
