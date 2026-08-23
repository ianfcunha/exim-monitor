/**
 * SettingsLayout — navegação interna das telas de configuração
 * (Geral, Alertas, Servidores, Usuários, Histórico, Manutenção). Cada
 * seção é uma rota aninhada de /settings, renderizada via <Outlet/>.
 *
 * Sessão 4, T8: o cabeçalho (logo, seletor de servidor, navegação
 * principal, usuário) saiu daqui e vive na casca única — AppShell.jsx.
 * Este arquivo cuida só da coluna lateral desta seção.
 */
import { AlertTriangle, Bell, History, Home, Server, Users } from 'lucide-react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'

const NAV_ITEMS = [
  { to: '/settings',             end: true,  label: 'Geral',       Icon: Home,          adminOnly: false },
  { to: '/settings/alerts',      end: false, label: 'Alertas',      Icon: Bell,          adminOnly: true },
  { to: '/settings/servers',     end: false, label: 'Servidores',   Icon: Server,        adminOnly: true },
  { to: '/settings/users',       end: false, label: 'Usuários',     Icon: Users,         adminOnly: true },
  { to: '/settings/history',     end: false, label: 'Histórico',    Icon: History,       adminOnly: true },
  { to: '/settings/maintenance', end: false, label: 'Manutenção',   Icon: AlertTriangle, adminOnly: true },
]

export default function SettingsLayout() {
  const { search } = useLocation()
  const { isAdmin } = useAuth()
  const items = NAV_ITEMS.filter(i => !i.adminOnly || isAdmin)

  return (
    <div style={{ background: 'var(--surface)', width: '100%' }}>

      <div className="settings-shell" style={{
        maxWidth: 1100, margin: '0 auto', padding: '20px 24px',
        display: 'flex', gap: 24, alignItems: 'flex-start',
      }}>
        <nav className="settings-nav" style={{
          flexShrink: 0, width: 180, position: 'sticky', top: 96,
          display: 'flex', flexDirection: 'column', gap: 2,
        }}>
          {items.map(({ to, end, label, Icon }) => (
            <NavLink
              key={to} to={`${to}${search}`} end={end}
              style={({ isActive }) => ({
                display: 'flex', alignItems: 'center', gap: 9,
                padding: '8px 12px', borderRadius: 8,
                fontSize: 12.5, fontWeight: isActive ? 700 : 500,
                color: isActive ? 'var(--accent-fg)' : 'var(--muted)',
                background: isActive ? 'var(--accent-bg)' : 'transparent',
                textDecoration: 'none', transition: 'background 0.15s, color 0.15s',
              })}
            >
              <Icon size={14} style={{ flexShrink: 0 }} />
              {label}
            </NavLink>
          ))}
        </nav>

        <main style={{ flex: 1, minWidth: 0 }}>
          <Outlet />
        </main>
      </div>

      <style>{`
        @media (max-width: 720px) {
          .settings-shell { flex-direction: column; }
          .settings-nav {
            position: static; width: 100%; flex-direction: row;
            overflow-x: auto; padding-bottom: 4px; gap: 6px;
          }
          .settings-nav a { flex-shrink: 0; }
        }
      `}</style>
    </div>
  )
}
