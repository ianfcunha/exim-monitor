/**
 * Página de login — identidade AVILI light profissional.
 */
import { useState } from 'react'
import { login } from '../api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field } from '@/components/primitives/field'

function LogoMark({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 60 60" fill="none" aria-hidden>
      <path d="M10 46 L30 16 L50 46" fill="none" stroke="var(--text)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M18 36 L30 26 L42 36" fill="none" stroke="var(--sky)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="30" cy="16" r="2.5" fill="var(--sky)"/>
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
      className="flex min-h-screen items-center justify-center bg-surface px-4"
      style={{
        backgroundImage: `
          radial-gradient(ellipse 700px 500px at 15% 15%, rgba(228,87,46,0.10) 0%, transparent 60%),
          radial-gradient(ellipse 600px 400px at 85% 85%, rgba(242,148,107,0.07) 0%, transparent 55%)
        `,
        backgroundAttachment: 'fixed',
      }}
    >
      <div className="w-full max-w-[380px]">

        {/* Logo + título */}
        <div className="mb-7 text-center">
          <div className="mx-auto mb-3.5 flex h-16 w-16 items-center justify-center rounded-[18px] border border-border bg-card shadow-[0_4px_16px_rgba(0,0,0,0.08)]">
            <LogoMark size={34} />
          </div>
          <h1 className="m-0 text-[22px] font-extrabold tracking-tight">
            <span className="text-foreground">Mail </span>
            <span className="text-primary">IQ</span>
          </h1>
          <p className="mt-1.5 text-[10px] font-semibold uppercase tracking-[0.24em] text-dim">
            by <span className="text-primary">AVILI</span>
          </p>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-border bg-card p-6 shadow-[0_4px_24px_rgba(0,0,0,0.06),0_1px_3px_rgba(0,0,0,0.04)]">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">

            <Field label="Usuário" htmlFor="username" className="mb-0">
              <Input
                id="username" type="text" autoComplete="username"
                value={username} onChange={e => setUsername(e.target.value)}
                required placeholder="admin"
              />
            </Field>

            <Field label="Senha" htmlFor="password" className="mb-0">
              <Input
                id="password" type="password" autoComplete="current-password"
                value={password} onChange={e => setPassword(e.target.value)}
                required placeholder="••••••••"
              />
            </Field>

            {error && (
              <div className="rounded-lg border border-destructive-border bg-destructive-bg px-3 py-2.5 text-[12px] text-destructive">
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
