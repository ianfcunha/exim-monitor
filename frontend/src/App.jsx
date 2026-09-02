import { useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import AppShell from './components/AppShell'
import { AuthProvider } from './contexts/AuthContext'
import { LicenseProvider } from './contexts/LicenseContext'
import { ServerProvider } from './contexts/ServerContext'
import { ToastProvider } from './contexts/ToastContext'
import { useAdvancedMode } from './hooks/useAdvancedMode'
import { useClassicDesign } from './hooks/useClassicDesign'
import { useDarkMode } from './hooks/useDarkMode'
import ActionHistoryPage from './pages/ActionHistoryPage'
import Dashboard from './pages/Dashboard'
import FrotaPage from './pages/FrotaPage'
import GeneralSettings from './pages/GeneralSettings'
import IncidentReportPage from './pages/IncidentReportPage'
import InviteAccept from './pages/InviteAccept'
import Login from './pages/Login'
import MaintenancePage from './pages/MaintenancePage'
import MetricasPage from './pages/MetricasPage'
import PlanoPage from './pages/PlanoPage'
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

// Redireciona preservando o `?server=` — Sessão 4, T8: o escopo de
// servidor não pode ser perdido num redirect interno.
function ScopedRedirect({ to }) {
  const { search } = useLocation()
  return <Navigate to={`${to}${search}`} replace />
}

export default function App() {
  const [token, setToken] = useState(() => localStorage.getItem('exim_token'))
  // Chamado incondicionalmente, antes de qualquer early-return — aplica a
  // classe .dark no <html> em toda tela (Login incluso), não só onde o
  // controle de toggle é exibido.
  const { isDark, toggleTheme } = useDarkMode()
  // Sessão 3, T6 — "poda": gráficos históricos, log viewer e atalhos
  // fora da Triagem só aparecem com isto ligado (padrão: desligado).
  const { advanced, toggleAdvanced } = useAdvancedMode()
  // Sessão 6: o design "Tinta e Coral" é o padrão; a casca/paleta
  // anteriores (AVILI) ficam desligadas, religáveis em Configurações →
  // Geral — mesmo motivo de existir do useAdvancedMode (preferência de
  // quem usa, e disponível se precisarmos reverter depois).
  const { classic, toggleClassic } = useClassicDesign()

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
  // Sessão 6: o toggle de tema mora na navbar (casca única), não só
  // dentro de Configurações → Geral — por isso vai pra AppShell em toda
  // rota, não só na de Settings (que ainda o repassa pra GeneralSettings
  // via `props`, de onde o controle antigo continua funcionando também).
  const shell = (page, props = {}) => (
    <AppShell onLogout={logout} isDark={isDark} onToggleTheme={toggleTheme} classic={classic} {...props}>{page}</AppShell>
  )

  return (
    <TooltipProvider delayDuration={300}>
    <ToastProvider>
      <AuthProvider token={token}>
        {/* Sessão 4, T8: o Router envolve o ServerProvider (e não o
            contrário) porque a seleção de servidor virou estado de URL —
            o provider precisa de useSearchParams. */}
        <BrowserRouter>
        <ServerProvider>
        {/* Dentro do Router: o provider é lido pelo banner da casca e pela
            tela de Servidores, ambos abaixo daqui. */}
        <LicenseProvider>
          <Routes>
            {/* Triagem é a tela inicial — "ninguém abre um painel de
                e-mail quando está tudo bem". */}
            <Route path="/triage"     element={shell(<TriagePage />)} />
            <Route path="/triage/:id" element={shell(<TriagePage />)} />
            {/* Formato usado pelo link nas notificações (Telegram/e-mail/
                webhook — incident_notify.py::_incident_url()):
                {app_url}/incidents/INC-####, por display_id. */}
            <Route path="/incidents/:displayId" element={shell(<TriagePage />)} />
            {/* Sessão 4, T9: relatório com endereço permanente, no lugar
                do blob: em aba nova que não dava para voltar nem
                compartilhar. Fora da casca de propósito — é a página
                que o dono do host encaminha ao cliente dele. */}
            <Route path="/incidents/:id/report" element={<IncidentReportPage />} />

            {/* Sessão 6 — telas do handoff Mail IQ 2.0 */}
            <Route path="/frota"    element={shell(<FrotaPage />)} />
            <Route path="/metricas" element={shell(<MetricasPage />)} />
            <Route path="/plano"           element={shell(<PlanoPage />)} />
            <Route path="/plano/historico" element={shell(<PlanoPage view="historico" />)} />
            <Route path="/plano/:id"       element={shell(<PlanoPage />)} />

            <Route path="/reputation" element={shell(<ReputationPage />)} />
            {/* O painel clássico deixou de ser um destino e virou a aba
                "Fila". /dashboard continua funcionando para links antigos. */}
            <Route path="/queue"     element={shell(<Dashboard advanced={advanced} />)} />
            <Route path="/dashboard" element={<ScopedRedirect to="/queue" />} />

            <Route path="/settings" element={shell(<SettingsLayout />)}>
              <Route index          element={<GeneralSettings isDark={isDark} onToggleTheme={toggleTheme} advanced={advanced} onToggleAdvanced={toggleAdvanced} classic={classic} onToggleClassic={toggleClassic} />} />
              <Route path="alerts"  element={<Settings />} />
              <Route path="servers" element={<ServersPage />} />
              <Route path="users"   element={<UsersPage />} />
              <Route path="history" element={<ActionHistoryPage />} />
              <Route path="maintenance" element={<MaintenancePage />} />
            </Route>
            {/* Link antigo, de antes de Servidores virar uma aba. */}
            <Route path="/servers" element={<ScopedRedirect to="/settings/servers" />} />

            <Route path="*" element={<ScopedRedirect to="/triage" />} />
          </Routes>
        </LicenseProvider>
        </ServerProvider>
        </BrowserRouter>
      </AuthProvider>
    </ToastProvider>
    </TooltipProvider>
  )
}
