/**
 * GeneralSettings — aba "Geral" do SettingsLayout. Landing da área de
 * configurações: atalhos pras demais seções + preferência de tema (a
 * única preferência realmente "geral" que existe hoje — antes só dava
 * pra trocar pelo dropdown do header).
 */
import { AlertTriangle, Bell, ChevronRight, History, Moon, Server, Sparkles, Sun, Users } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '../contexts/AuthContext'

const LINKS = [
  { to: '/settings/alerts',      Icon: Bell,          title: 'Alertas',      desc: 'E-mail, Telegram, webhook, thresholds e relatório semanal.', adminOnly: true },
  { to: '/settings/servers',     Icon: Server,        title: 'Servidores',   desc: 'Cadastre e gerencie os servidores monitorados.',              adminOnly: true },
  { to: '/settings/users',       Icon: Users,         title: 'Usuários',     desc: 'Convide membros e gerencie permissões de acesso.',            adminOnly: true },
  { to: '/settings/history',     Icon: History,       title: 'Histórico',    desc: 'Auditoria de ações executadas em cada servidor.',             adminOnly: true },
  { to: '/settings/maintenance', Icon: AlertTriangle, title: 'Manutenção',   desc: 'Limpar toda a fila e restaurar mensagens da quarentena.',     adminOnly: true },
]

export default function GeneralSettings({ isDark, onToggleTheme, advanced, onToggleAdvanced }) {
  const { isAdmin } = useAuth()
  // Sessão 5: os cards tinham href sem `?server=`. O clique preservava o
  // escopo porque o SPA reescreve a URL depois, mas "copiar endereço do
  // link" produzia um link sem servidor — que abre no escopo de quem
  // clica, não no de quem mandou. Um link colado no chat precisa levar o
  // contexto junto; é o motivo de o servidor viver na URL (T8).
  const { search } = useLocation()
  const links = LINKS.filter(l => !l.adminOnly || isAdmin)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{
        background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
        padding: '20px 20px 16px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
      }}>
        <p style={{ fontSize: 10, letterSpacing: '0.30em', textTransform: 'uppercase', color: 'var(--sky)', fontWeight: 700, marginBottom: 16 }}>
          Aparência
        </p>
        <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', userSelect: 'none' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {isDark ? <Moon size={15} color="var(--muted)" /> : <Sun size={15} color="var(--muted)" />}
            <span style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>Tema escuro</span>
          </span>
          <Switch checked={!!isDark} onCheckedChange={onToggleTheme} />
        </label>
      </div>

      {/* Sessão 3, T6 — "poda": estes recursos ficam fora do Painel
          clássico por padrão (log viewer, detector de PHP malicioso,
          gráficos históricos, badge de papel, atalhos R/L). Ligar aqui
          não afeta a Triagem, que já é o caminho principal. */}
      <div style={{
        background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
        padding: '20px 20px 16px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
      }}>
        <p style={{ fontSize: 10, letterSpacing: '0.30em', textTransform: 'uppercase', color: 'var(--sky)', fontWeight: 700, marginBottom: 16 }}>
          Painel clássico
        </p>
        <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', userSelect: 'none' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Sparkles size={15} color="var(--muted)" />
            <span style={{ fontSize: 13, color: 'var(--text)', fontWeight: 500 }}>Modo avançado</span>
          </span>
          <Switch checked={!!advanced} onCheckedChange={onToggleAdvanced} />
        </label>
        <p style={{ fontSize: 11, color: 'var(--dim)', marginTop: 8, lineHeight: 1.5 }}>
          Mostra o log viewer, o detector de PHP mailers, os gráficos históricos
          elaborados, o badge de papel (admin/viewer) e os atalhos de teclado do
          Painel clássico (R/L). Desligado por padrão — a Triagem é a tela pra
          uso do dia a dia.
        </p>
      </div>

      {links.length > 0 && (
      <div>
        <p style={{ fontSize: 10, letterSpacing: '0.30em', textTransform: 'uppercase', color: 'var(--sky)', fontWeight: 700, margin: '4px 0 12px' }}>
          Áreas de configuração
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
          {links.map(({ to, Icon, title, desc }) => (
            <Link key={to} to={`${to}${search}`} style={{
              display: 'flex', alignItems: 'flex-start', gap: 12,
              background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
              padding: '16px 16px', textDecoration: 'none',
              boxShadow: '0 1px 3px rgba(0,0,0,0.05)', transition: 'border-color 0.15s, transform 0.15s',
            }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--sky)'; e.currentTarget.style.transform = 'translateY(-1px)' }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.transform = 'none' }}
            >
              <div style={{
                flexShrink: 0, width: 34, height: 34, borderRadius: 9,
                background: 'var(--accent-bg)', color: 'var(--accent-fg)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Icon size={16} />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)' }}>{title}</span>
                  <ChevronRight size={13} color="var(--dim)" style={{ flexShrink: 0 }} />
                </div>
                <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '3px 0 0', lineHeight: 1.4 }}>{desc}</p>
              </div>
            </Link>
          ))}
        </div>
      </div>
      )}
    </div>
  )
}
