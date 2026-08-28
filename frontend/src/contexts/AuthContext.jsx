/**
 * AuthContext — armazena informações do usuário autenticado.
 * O role ('admin' | 'viewer') é lido do payload do JWT sem chamada extra ao backend.
 *
 * Hook:
 *   const { role, isAdmin, username } = useAuth()
 *
 * O token vem por prop de <App> (o mesmo `useState` que decide entre a
 * tela de Login e o app). Antes este provider lia `localStorage.getItem`
 * direto no corpo do componente: no primeiro render logo após o login o
 * token ainda não tinha sido persistido (o `useEffect` de App que grava
 * no localStorage roda depois do render), então a árvore inteira montava
 * como `role: 'viewer'` — menu de admin escondido, avatar placeholder —
 * e só um F5 corrigia. Recebendo por prop, o provider re-renderiza no
 * mesmo tick em que o token muda.
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

export function AuthProvider({ token: tokenProp, children }) {
  // Fallback ao localStorage mantém o provider utilizável fora de App
  // (testes) — em produção o valor sempre chega por prop.
  const token   = tokenProp ?? (typeof localStorage !== 'undefined' ? localStorage.getItem('exim_token') : null)
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
