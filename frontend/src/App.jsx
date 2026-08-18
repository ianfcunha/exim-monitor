import { useEffect, useState } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AuthProvider } from './contexts/AuthContext'
import { ServerProvider } from './contexts/ServerContext'
import { ToastProvider } from './contexts/ToastContext'
import ActionHistoryPage from './pages/ActionHistoryPage'
import Dashboard from './pages/Dashboard'
import InviteAccept from './pages/InviteAccept'
import Login from './pages/Login'
import ServersPage from './pages/ServersPage'
import Settings from './pages/Settings'
import UsersPage from './pages/UsersPage'

// Convite via query param ?invite=TOKEN — funciona em qualquer proxy
function getInviteToken() {
  return new URLSearchParams(window.location.search).get('invite') ?? null
}

export default function App() {
  const [token, setToken]   = useState(() => localStorage.getItem('exim_token'))
  const [page, setPage]     = useState('dashboard')

  // Navegação via evento customizado (ServerSelector usa isso)
  useEffect(() => {
    const handler = (e) => setPage(e.detail)
    window.addEventListener('navigate', handler)
    return () => window.removeEventListener('navigate', handler)
  }, [])

  useEffect(() => {
    if (token) localStorage.setItem('exim_token', token)
    else       localStorage.removeItem('exim_token')
  }, [token])

  // Rota de convite — não requer autenticação
  const inviteToken = getInviteToken()
  if (inviteToken) {
    return <InviteAccept token={inviteToken} onDone={() => { window.location.href = '/' }} />
  }

  if (!token) return <Login onLogin={(t) => { setToken(t); setPage('dashboard') }} />

  const logout = () => { setToken(null); setPage('dashboard') }

  return (
    <TooltipProvider delayDuration={300}>
    <ToastProvider>
      <AuthProvider>
      <ServerProvider>
        {page === 'settings' && (
          <Settings onBack={() => setPage('dashboard')} />
        )}
        {page === 'servers' && (
          <ServersPage onBack={() => setPage('dashboard')} />
        )}
        {page === 'users' && (
          <UsersPage onBack={() => setPage('dashboard')} />
        )}
        {page === 'action-history' && (
          <ActionHistoryPage onBack={() => setPage('dashboard')} />
        )}
        {page === 'dashboard' && (
          <Dashboard
            onLogout={logout}
            onSettings={() => setPage('settings')}
            onServers={() => setPage('servers')}
            onUsers={() => setPage('users')}
            onActionHistory={() => setPage('action-history')}
          />
        )}
      </ServerProvider>
      </AuthProvider>
    </ToastProvider>
    </TooltipProvider>
  )
}
