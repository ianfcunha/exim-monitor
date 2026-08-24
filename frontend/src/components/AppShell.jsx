/**
 * AppShell — Sessão 4, Tarefa 8: casca de navegação única.
 *
 * Antes existiam duas aplicações coladas. A Triagem tinha cabeçalho
 * próprio, sem logo, sem seletor de servidor e sem acesso a
 * Configurações; para chegar em Servidores era preciso passar pelo
 * "Painel clássico", que tinha o cabeçalho de verdade. O contexto de
 * servidor não viajava entre as duas.
 *
 * Agora toda tela renderiza dentro desta casca: logo, seletor de
 * servidor/frota (estado global na URL — ver ServerContext), navegação,
 * estado da coleta e usuário. O painel clássico deixou de ser um
 * destino e virou a aba "Fila", como as outras.
 */
import { Inbox, Layers, LayoutGrid, LogOut, Settings, ShieldCheck } from 'lucide-react'
import { NavLink, useNavigate } from 'react-router-dom'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import ServerSelector from './ServerSelector'
import { useAuth } from '../contexts/AuthContext'
import { useServer } from '../contexts/ServerContext'

export function LogoMark({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2" y="5" width="20" height="14" rx="3" stroke="var(--sky)" strokeWidth="1.8" />
      <path d="M3.5 7.5 12 13l8.5-5.5" stroke="var(--sky)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

const NAV = [
  { to: '/triage',     label: 'Triagem',       Icon: Inbox },
  { to: '/queue',      label: 'Fila',          Icon: LayoutGrid },
  { to: '/reputation', label: 'Reputação',     Icon: ShieldCheck },
  { to: '/settings/servers', label: 'Servidores', Icon: Layers },
  { to: '/settings',   label: 'Configurações', Icon: Settings, end: true },
]

// Preserva o `?server=` ao navegar — é o que faz o contexto de servidor
// viajar entre telas em vez de cada uma recomeçar do zero.
function withScope(to) {
  const scope = new URLSearchParams(window.location.search).get('server')
  return scope ? `${to}?server=${scope}` : to
}

function ModeBadge() {
  // Sessão 4, Tarefa 12 — selo de modo observação no cabeçalho. Sem
  // isto o modo não aparecia em lugar nenhum da interface, e o painel
  // continuava exibindo ações destrutivas como botões comuns.
  //
  // Sessão 5: o selo dizia o que o modo faz mas não onde desligá-lo — um
  // aviso que interrompe o trabalho e não aponta a saída. Agora é um
  // link para Configurações → Servidores, que é onde a chave está.
  const { activeServer, servers, isFleet } = useServer()
  const inObservation = isFleet
    ? servers.length > 0 && servers.every(s => s.observation_mode)
    : activeServer?.observation_mode

  if (!inObservation) return null
  const scope = isFleet
    ? `${servers.length === 1 ? 'O servidor' : `Todos os ${servers.length} servidores`}`
    : activeServer.name
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <NavLink
          to={withScope('/settings/servers')}
          style={{
            fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
            background: 'var(--warn-bg)', border: '1px solid var(--warn-border)',
            color: 'var(--warn)', textTransform: 'uppercase', letterSpacing: '0.05em',
            flexShrink: 0, whiteSpace: 'nowrap', textDecoration: 'none',
          }}
        >
          Modo observação
        </NavLink>
      </TooltipTrigger>
      <TooltipContent>
        {scope} {isFleet && servers.length > 1 ? 'estão' : 'está'} em modo observação:
        nenhuma ação que altere o servidor será executada — o painel só lê e
        diagnostica. Clique para desligar em Configurações → Servidores.
      </TooltipContent>
    </Tooltip>
  )
}

function CollectionState() {
  const { activeServer, isFleet, servers } = useServer()
  const list = isFleet ? servers : (activeServer ? [activeServer] : [])
  if (list.length === 0) return null

  const broken = list.filter(s => s.ssh_status !== 'ok')
  const color = broken.length === 0 ? 'var(--ok)' : 'var(--danger)'
  const label = broken.length === 0
    ? 'Coleta ativa'
    : `${broken.length} servidor${broken.length === 1 ? '' : 'es'} sem coleta`

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="hidden md:flex items-center gap-1.5"
             style={{ fontSize: 11, color, flexShrink: 0, whiteSpace: 'nowrap' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
          {label}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        {broken.length === 0
          ? 'Todos os servidores no escopo estão respondendo à coleta.'
          : broken.map(s => `${s.name}: ${s.ssh_error_msg || s.ssh_status}`).join(' · ')}
      </TooltipContent>
    </Tooltip>
  )
}

export default function AppShell({ children, onLogout, right = null, dense = false }) {
  const navigate = useNavigate()
  const { username } = useAuth()

  return (
    <div style={{ minHeight: '100vh', background: 'var(--surface)', display: 'flex', flexDirection: 'column' }}>
      <header style={{
        position: 'sticky', top: 0, zIndex: 20,
        background: 'var(--card)', borderBottom: '1px solid var(--border)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)', flexShrink: 0,
      }}>
        <div style={{
          padding: '0 20px', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', gap: 12, height: 54,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <button
              onClick={() => navigate(withScope('/triage'))}
              style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
                       background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
            >
              <div style={{
                width: 32, height: 32, borderRadius: 9, background: 'var(--accent-bg)',
                border: '1px solid var(--accent-border)', display: 'flex',
                alignItems: 'center', justifyContent: 'center',
              }}>
                <LogoMark size={18} />
              </div>
              <div className="hidden sm:block" style={{ lineHeight: 1.2, textAlign: 'left' }}>
                <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '-0.01em' }}>
                  <span style={{ color: 'var(--text)' }}>Mail </span><span style={{ color: 'var(--sky)' }}>IQ</span>
                </div>
                <div style={{ fontSize: 8.5, letterSpacing: '0.18em', textTransform: 'uppercase', fontWeight: 600, color: 'var(--dim)' }}>
                  by <span style={{ color: 'var(--sky)' }}>AVILI</span>
                </div>
              </div>
            </button>

            <span style={{ width: 1, height: 18, background: 'var(--border)', flexShrink: 0 }} />
            <ServerSelector />
            <ModeBadge />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <CollectionState />
            {right}
            {username && (
              <span className="hidden lg:inline" style={{ fontSize: 11, color: 'var(--dim)', whiteSpace: 'nowrap' }}>
                {username}
              </span>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onLogout}
                  style={{ display: 'flex', alignItems: 'center', background: 'none',
                           border: 'none', padding: 6, cursor: 'pointer', color: 'var(--dim)' }}
                >
                  <LogOut size={14} />
                </button>
              </TooltipTrigger>
              <TooltipContent>Sair</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <nav style={{
          padding: '0 20px', display: 'flex', gap: 2, alignItems: 'center',
          overflowX: 'auto', borderTop: '1px solid var(--border)',
        }}>
          {NAV.map(({ to, label, Icon, end }) => (
            <NavLink
              key={to} to={withScope(to)} end={end}
              style={({ isActive }) => ({
                display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
                padding: '9px 12px', fontSize: 12.5,
                fontWeight: isActive ? 700 : 500,
                color: isActive ? 'var(--accent-fg)' : 'var(--muted)',
                borderBottom: `2px solid ${isActive ? 'var(--sky)' : 'transparent'}`,
                textDecoration: 'none', transition: 'color 0.15s, border-color 0.15s',
              })}
            >
              <Icon size={13} style={{ flexShrink: 0 }} />
              {label}
            </NavLink>
          ))}
        </nav>
      </header>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
                    padding: dense ? 0 : undefined }}>
        {children}
      </div>
    </div>
  )
}
