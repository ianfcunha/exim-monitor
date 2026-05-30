/**
 * AuthContext — armazena informações do usuário autenticado.
 * O role ('admin' | 'viewer') é lido do payload do JWT sem chamada extra ao backend.
 *
 * Hook:
 *   const { role, isAdmin, username } = useAuth()
 */
import { createContext, useContext, useMemo } from 'react'

const AuthContext = createContext(null)

function parseJwt(token) {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
  } catch {
    return null
  }
}

export function AuthProvider({ children }) {
  const token   = localStorage.getItem('exim_token')
  const payload = useMemo(() => parseJwt(token), [token])

  const value = {
    role:    payload?.role    ?? 'viewer',
    isAdmin: payload?.role    === 'admin',
    username: payload?.sub    ?? '',
    userId:  payload?.user_id ?? null,
    ownerId: payload?.owner_id ?? null,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth deve ser usado dentro de <AuthProvider>')
  return ctx
}
