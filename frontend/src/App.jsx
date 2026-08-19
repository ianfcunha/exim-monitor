import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AuthProvider } from './contexts/AuthContext'
import { ServerProvider } from './contexts/ServerContext'
import { ToastProvider } from './contexts/ToastContext'
import { useDarkMode } from './hooks/useDarkMode'
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
  const [token, setToken] = useState(() => localStorage.getItem('exim_token'))
  // Chamado incondicionalmente, antes de qualquer early-return — aplica a
  // classe .dark no <html> em toda tela (Login incluso), não só onde o
  // controle de toggle é exibido (menu de configurações do Dashboard).
  const { isDark, toggleTheme } = useDarkMode()

  useEffect(() => {
    if (token) localStorage.setItem('exim_token', token)
    else       localStorage.removeItem('exim_token')
  }, [token])

  // Rota de convite — não requer autenticação
  const inviteToken = getInviteToken()
  if (inviteToken) {
    return <InviteAccept token={inviteToken} onDone={() => { window.location.href = '/' }} />
  }

  if (!token) return <Login onLogin={setToken} />

  const logout = () => setToken(null)

  return (
    <TooltipProvider delayDuration={300}>
    <ToastProvider>
      <AuthProvider>
      <ServerProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/dashboard" element={<Dashboard onLogout={logout} isDark={isDark} onToggleTheme={toggleTheme} />} />
            <Route path="/servers"   element={<ServersPage />} />
            <Route path="/users"     element={<UsersPage />} />
            <Route path="/settings"  element={<Settings />} />
            <Route path="/history"   element={<ActionHistoryPage />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </BrowserRouter>
      </ServerProvider>
      </AuthProvider>
    </ToastProvider>
    </TooltipProvider>
  )
}
