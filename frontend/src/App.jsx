import { useEffect, useState } from 'react'
import { ToastProvider } from './contexts/ToastContext'
import Dashboard from './pages/Dashboard'
import Login from './pages/Login'
import Settings from './pages/Settings'

export default function App() {
  const [token, setToken]   = useState(() => localStorage.getItem('exim_token'))
  const [page, setPage]     = useState('dashboard')

  useEffect(() => {
    if (token) localStorage.setItem('exim_token', token)
    else       localStorage.removeItem('exim_token')
  }, [token])

  if (!token) return <Login onLogin={setToken} />

  if (page === 'settings') {
    return (
      <ToastProvider>
        <Settings onBack={() => setPage('dashboard')} />
      </ToastProvider>
    )
  }

  return (
    <ToastProvider>
      <Dashboard
        onLogout={() => setToken(null)}
        onSettings={() => setPage('settings')}
      />
    </ToastProvider>
  )
}
