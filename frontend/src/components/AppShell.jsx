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
 *
 * Sessão 6 — retema visual "Tinta e Coral" (handoff Mail IQ 2.0): navbar
 * de uma linha só (era duas), abas em pílula (accentTint) no lugar do
 * sublinhado, toggle de tema embutido (antes só existia dentro de
 * Configurações → Geral — ver App.jsx), rodapé de status. Vira o
 * padrão, mas a casca/paleta anteriores não foram descartadas — a prop
 * `classic` (useClassicDesign.js, desligada por padrão, religável em
 * Configurações → Geral) faz este componente renderizar a versão
 * anterior inteira: duas linhas, abas sublinhadas, sem rodapé, sem
 * toggle/sino/avatar na navbar. O seletor de servidor e o selo de modo
 * observação não têm equivalente no mockup novo (ele não modela "vários
 * servidores"/frota multi-tenant) — ficam preservados nos dois modos
 * porque são funcionalidade real do produto, não decoração.
 */
import {
  Bell, ClipboardList, Inbox, Layers, LayoutGrid, LineChart,
  LogOut, Moon, Server, Settings, ShieldCheck, Sun,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { fetchIncidentsSummary } from '../api/client'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import ServerSelector from './ServerSelector'
import { useAuth } from '../contexts/AuthContext'
import { useServer } from '../contexts/ServerContext'

// Marca "Mail IQ" do handoff — triângulo (envelope estilizado) + circle,
// mesmo desenho do favicon (index.html). stroke/fill por var(--text) e
// var(--sky) (== `accent` do handoff nos dois temas) para acompanhar o tema.
export function LogoMark({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 60 60" fill="none" aria-hidden="true">
      <path d="M10 46 L30 16 L50 46" stroke="var(--text)" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M18 36 L30 26 L42 36" stroke="var(--sky)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="30" cy="16" r="3" fill="var(--sky)" />
    </svg>
  )
}

const NEW_NAV = [
  { to: '/triage',     label: 'Triagem',            Icon: Inbox,         badge: 'incidents' },
  { to: '/frota',      label: 'Frota',               Icon: LayoutGrid },
  { to: '/metricas',   label: 'Métricas',             Icon: LineChart },
  { to: '/plano',      label: 'Plano de correção',    Icon: ClipboardList, badge: 'incidents' },
  { to: '/reputation', label: 'Reputação',            Icon: ShieldCheck },
  { to: '/settings',   label: 'Configurações',        Icon: Settings, end: true },
]

// Casca anterior ao redesign — preservada atrás de `classic` (ver
// cabeçalho do arquivo), não mais o caminho padrão.
const CLASSIC_NAV = [
  { to: '/triage',           label: 'Triagem',       Icon: Inbox },
  { to: '/queue',            label: 'Fila',          Icon: LayoutGrid },
  { to: '/reputation',       label: 'Reputação',     Icon: ShieldCheck },
  { to: '/settings/servers', label: 'Servidores',    Icon: Layers },
  { to: '/settings',         label: 'Configurações', Icon: Settings, end: true },
]

// Preserva o `?server=` ao navegar — é o que faz o contexto de servidor
// viajar entre telas em vez de cada uma recomeçar do zero.
function withScope(to) {
  const scope = new URLSearchParams(window.location.search).get('server')
  return scope ? `${to}?server=${scope}` : to
}

// Contagem de incidentes ativos, sempre da FROTA INTEIRA (não do escopo
// de servidor selecionado) — é a mesma pergunta do banner de alerta do
// handoff ("1 conta comprometida em srv-04 · mais 2 em atenção"): quer
// saber se há algo pegando fogo em qualquer lugar, não só no que está
// na tela agora. Poll de 30s — mesma cadência da Triagem.
function useFleetIncidentCount() {
  const [count, setCount] = useState(0)
  useEffect(() => {
    let alive = true
    const load = () => fetchIncidentsSummary(null)
      .then(s => { if (alive) setCount((s?.open_critico ?? 0) + (s?.open_atencao ?? 0)) })
      .catch(() => {})
    load()
    const id = setInterval(load, 30_000)
    return () => { alive = false; clearInterval(id) }
  }, [])
  return count
}

function NavBadge({ n }) {
  if (!n) return null
  return (
    <span style={{
      background: 'var(--danger)', color: '#fff', fontSize: 10, fontWeight: 700,
      borderRadius: 999, padding: '1px 6px', lineHeight: 1.6, flexShrink: 0,
    }}>
      {n}
    </span>
  )
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

function ThemeToggle({ isDark, onToggleTheme }) {
  if (!onToggleTheme) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onToggleTheme}
          style={{
            width: 30, height: 30, borderRadius: 8, background: 'var(--surface-alt)',
            border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--muted)', cursor: 'pointer', flexShrink: 0,
          }}
        >
          {isDark ? <Moon size={14} /> : <Sun size={14} />}
        </button>
      </TooltipTrigger>
      <TooltipContent>Alternar tema</TooltipContent>
    </Tooltip>
  )
}

// ── Casca clássica (AVILI) — preservada atrás de `classic` ──────────────
function ClassicShell({ children, onLogout, right, dense }) {
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
          {CLASSIC_NAV.map(({ to, label, Icon, end }) => (
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

// ── Casca nova (Tinta e Coral / Mail IQ 2.0) — padrão ────────────────────
function NewShell({ children, onLogout, right, dense, isDark, onToggleTheme }) {
  const navigate = useNavigate()
  const { username } = useAuth()
  const incidentCount = useFleetIncidentCount()

  return (
    <div style={{ minHeight: '100vh', background: 'var(--surface)', display: 'flex', flexDirection: 'column' }}>
      <header style={{
        position: 'sticky', top: 0, zIndex: 20, height: 56, flexShrink: 0,
        background: 'var(--card)', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', padding: '0 20px', gap: 4,
      }}>
        {/* Logo + wordmark */}
        <button
          onClick={() => navigate(withScope('/triage'))}
          style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, marginRight: 14,
                   background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
        >
          <LogoMark size={22} />
          <div className="hidden sm:block" style={{ lineHeight: 1.15, textAlign: 'left' }}>
            <div style={{ fontSize: 14, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text)' }}>
              Mail IQ
            </div>
            <div style={{ fontSize: 8.5, letterSpacing: '0.16em', textTransform: 'uppercase', fontWeight: 600, color: 'var(--dim)' }}>
              by AVILI
            </div>
          </div>
        </button>

        <span style={{ width: 1, height: 18, background: 'var(--border)', flexShrink: 0, marginRight: 10 }} />
        <div style={{ flexShrink: 0, marginRight: 4 }}>
          <ServerSelector />
        </div>

        {/* Abas — pílula com accentTint quando ativa (handoff Mail IQ 2.0) */}
        <nav style={{ display: 'flex', gap: 2, alignItems: 'center', overflowX: 'auto', minWidth: 0 }}>
          {NEW_NAV.map(({ to, label, Icon, end, badge }) => (
            <NavLink
              key={to} to={withScope(to)} end={end}
              style={({ isActive }) => ({
                display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0,
                padding: '7px 12px', borderRadius: 8, fontSize: 13, whiteSpace: 'nowrap',
                fontWeight: isActive ? 600 : 400,
                background: isActive ? 'var(--accent-bg)' : 'transparent',
                color: isActive ? 'var(--accent-fg)' : 'var(--muted)',
                textDecoration: 'none', transition: 'color 0.15s, background-color 0.15s',
              })}
            >
              <Icon size={13} style={{ flexShrink: 0 }} />
              {label}
              {badge === 'incidents' && <NavBadge n={incidentCount} />}
            </NavLink>
          ))}
        </nav>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, paddingLeft: 8 }}>
          <ModeBadge />
          <CollectionState />
          {right}
          <ThemeToggle isDark={isDark} onToggleTheme={onToggleTheme} />

          <div className="hidden md:flex" style={{ position: 'relative', width: 30, height: 30, alignItems: 'center', justifyContent: 'center' }}>
            <Bell size={15} color="var(--muted)" />
            {incidentCount > 0 && (
              <span style={{
                position: 'absolute', top: 5, right: 5, width: 6, height: 6, borderRadius: '50%',
                background: 'var(--danger)', border: '1.5px solid var(--card)',
              }} />
            )}
          </div>

          {username && (
            <span className="hidden lg:inline" style={{ fontSize: 11, color: 'var(--dim)', whiteSpace: 'nowrap' }}>
              {username}
            </span>
          )}
          <div style={{
            width: 26, height: 26, borderRadius: '50%', background: 'var(--text)', color: 'var(--card)',
            fontSize: 10, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center',
            letterSpacing: '0.02em', flexShrink: 0,
          }}>
            {(username || 'IC').slice(0, 2).toUpperCase()}
          </div>
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
      </header>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
                    padding: dense ? 0 : undefined }}>
        {children}
      </div>

      <FooterStatusBar incidentCount={incidentCount} />
    </div>
  )
}

function FooterStatusBar({ incidentCount }) {
  const { servers, isFleet, activeServer } = useServer()
  const list = isFleet ? servers : (activeServer ? [activeServer] : [])
  const activeCount = list.filter(s => s.is_enabled).length

  return (
    <footer style={{
      height: 36, background: 'var(--card)', borderTop: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', padding: '0 20px', gap: 14, flexShrink: 0,
    }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--muted)' }}>
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: incidentCount > 0 ? 'var(--danger)' : 'var(--ok)',
          animation: incidentCount > 0 ? 'pulse-sky 1.4s ease-in-out infinite' : undefined,
        }} />
        {incidentCount > 0 ? `${incidentCount} ativo${incidentCount === 1 ? '' : 's'}` : 'Tudo normal'}
      </span>
      <span className="hidden sm:inline" style={{ fontSize: 11.5, color: 'var(--dim)' }}>·</span>
      <span className="hidden sm:flex" style={{ alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--muted)' }}>
        <Server size={10} /> {activeCount} servidor{activeCount === 1 ? '' : 'es'} ativo{activeCount === 1 ? '' : 's'}
      </span>
      <span className="hidden md:inline" style={{
        marginLeft: 'auto', fontFamily: "'JetBrains Mono', monospace", fontSize: 10.5,
        color: 'var(--dim)', letterSpacing: '0.03em',
      }}>
        Mail IQ 2.0 · Tinta e Coral
      </span>
    </footer>
  )
}

export default function AppShell({
  children, onLogout, right = null, dense = false,
  isDark = false, onToggleTheme = null, classic = false,
}) {
  return classic
    ? <ClassicShell onLogout={onLogout} right={right} dense={dense}>{children}</ClassicShell>
    : <NewShell onLogout={onLogout} right={right} dense={dense} isDark={isDark} onToggleTheme={onToggleTheme}>{children}</NewShell>
}
