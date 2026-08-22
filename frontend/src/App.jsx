import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AuthProvider } from './contexts/AuthContext'
import { ServerProvider } from './contexts/ServerContext'
import { ToastProvider } from './contexts/ToastContext'
import { useDarkMode } from './hooks/useDarkMode'
import ActionHistoryPage from './pages/ActionHistoryPage'
import Dashboard from './pages/Dashboard'
import GeneralSettings from './pages/GeneralSettings'
import InviteAccept from './pages/InviteAccept'
import Login from './pages/Login'
import MaintenancePage from './pages/MaintenancePage'
import ReputationPage from './pages/ReputationPage'
import ServersPage from './pages/ServersPage'
import Settings from './pages/Settings'
import SettingsLayout from './pages/SettingsLayout'
import TriagePage from './pages/TriagePage'
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
            {/* Sessão 2, T6: Triagem é a tela inicial — o dashboard de
                métricas vira aba secundária em /dashboard (instrução
                explícita: "ninguém abre um painel de e-mail quando está
                tudo bem"). */}
            <Route path="/triage" element={<TriagePage />} />
            <Route path="/triage/:id" element={<TriagePage />} />
            {/* Formato usado pelo link nas notificações (Telegram/e-mail/
                webhook, T4 — incident_notify.py::_incident_url()):
                {app_url}/incidents/INC-####, por display_id, não pelo id
                numérico interno. */}
            <Route path="/incidents/:displayId" element={<TriagePage />} />
            <Route path="/reputation" element={<ReputationPage />} />
            <Route path="/dashboard" element={<Dashboard onLogout={logout} />} />
            <Route path="/settings" element={<SettingsLayout />}>
              <Route index          element={<GeneralSettings isDark={isDark} onToggleTheme={toggleTheme} />} />
              <Route path="alerts"  element={<Settings />} />
              <Route path="servers" element={<ServersPage />} />
              <Route path="users"   element={<UsersPage />} />
              <Route path="history" element={<ActionHistoryPage />} />
              <Route path="maintenance" element={<MaintenancePage />} />
            </Route>
            <Route path="*" element={<Navigate to="/triage" replace />} />
          </Routes>
        </BrowserRouter>
      </ServerProvider>
      </AuthProvider>
    </ToastProvider>
    </TooltipProvider>
  )
}
