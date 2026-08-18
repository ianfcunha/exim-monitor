/**
 * Dashboard principal — identidade AVILI light profissional.
 * Estilo admin dashboard: header branco, fundo slate-100, cards brancos com sombra.
 *
 * Melhorias UX incluídas:
 *   - Título dinâmico da aba conforme severidade
 *   - Badge de role (Admin/Viewer) + username no header
 *   - Tendência nos MetricCards (seta ↑↓ vs coleta anterior)
 *   - Tooltips explicativos nos cards
 *   - DiagnosisPanel colapsável (auto-colapsa em OK, auto-expande em CRITICAL)
 *   - Atalhos de teclado: R=Refresh, L=Logs
 */
import {
  CheckCircle, ChevronDown, Clock, FileText, History, Inbox,
  LogOut, MailOpen, RefreshCw, Server, Settings, Users, XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { refreshStatus } from '../api/client'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import ActionPanel from '../components/ActionPanel'
import DeliverabilityCard from '../components/DeliverabilityCard'
import DeliveryRateCard from '../components/DeliveryRateCard'
import DiagnosisPanel from '../components/DiagnosisPanel'
import HistoryChart from '../components/HistoryChart'
import HourlyBarChart from '../components/HourlyBarChart'
import LogViewerDrawer from '../components/LogViewerDrawer'
import MessagesDrawer from '../components/MessagesDrawer'
import MetricCard from '../components/MetricCard'
import PhpMailersCard from '../components/PhpMailersCard'
import ServerSelector from '../components/ServerSelector'
import TopTable from '../components/TopTable'
import { useAuth } from '../contexts/AuthContext'
import { useServer } from '../contexts/ServerContext'
import { useFullStatus, useQuickStatus } from '../hooks/useStatus'

// ── Formatação de números ────────────────────────────────────────────────────
function fmt(n) {
  if (n == null) return '—'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1000)      return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

// ── Staleness do dado ────────────────────────────────────────────────────────
function useStaleness(ts) {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick(n => n + 1), 10_000)
    return () => clearInterval(id)
  }, [])
  if (!ts) return null
  const diffS = Math.floor((Date.now() - new Date(ts).getTime()) / 1000)
  if (diffS < 60)  return { color: '#0EA5E9', dot: '#0EA5E9', label: `${diffS}s atrás`,                         pulse: false }
  if (diffS < 300) return { color: '#D97706', dot: '#F59E0B', label: `${Math.floor(diffS/60)}min atrás`,        pulse: false }
  return               { color: '#DC2626', dot: '#EF4444', label: `${Math.floor(diffS/60)}min · desatualizado`, pulse: true  }
}

// ── Logo SVG AVILI ───────────────────────────────────────────────────────────
function LogoMark({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 60 60" fill="none" aria-hidden>
      <path d="M10 46 L30 16 L50 46" fill="none" stroke="#0F172A" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M18 36 L30 26 L42 36" fill="none" stroke="#0EA5E9" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="30" cy="16" r="2.5" fill="#22D3EE"/>
    </svg>
  )
}

// ── Botão do header ──────────────────────────────────────────────────────────
function HBtn({ onClick, disabled, title, children }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="sm" onClick={onClick} disabled={disabled}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{title}</TooltipContent>
    </Tooltip>
  )
}

// ── StatusPill clicável ──────────────────────────────────────────────────────
function StatusPill({ color, label, children }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="flex flex-shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold outline-none focus-visible:ring-1 focus-visible:ring-primary"
          style={{ border: `1px solid ${color}25`, background: `${color}0f`, color }}
        >
          <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: color }} />
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent>{children}</PopoverContent>
    </Popover>
  )
}

// ── Dropdown de configurações ────────────────────────────────────────────────
function SettingsMenu({ onSettings, onServers, onUsers, onActionHistory, onLogout, isAdmin }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" title="Configurações" className="group">
          <Settings size={12} />
          <span className="hidden sm:inline">Configurações</span>
          <ChevronDown size={11} className="transition-transform group-data-[state=open]:rotate-180" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {isAdmin && (
          <DropdownMenuItem onSelect={onServers}>
            <Server size={13} /> Servidores
          </DropdownMenuItem>
        )}
        {isAdmin && (
          <DropdownMenuItem onSelect={onSettings}>
            <Settings size={13} /> Alertas
          </DropdownMenuItem>
        )}
        {isAdmin && (
          <DropdownMenuItem onSelect={onUsers}>
            <Users size={13} /> Usuários
          </DropdownMenuItem>
        )}
        {isAdmin && (
          <DropdownMenuItem onSelect={onActionHistory}>
            <History size={13} /> Histórico de ações
          </DropdownMenuItem>
        )}
        {isAdmin && <DropdownMenuSeparator />}
        <DropdownMenuItem destructive onSelect={onLogout}>
          <LogOut size={13} /> Sair
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ── Tooltips por métrica ─────────────────────────────────────────────────────
const METRIC_TOOLTIPS = {
  queue:     'Total de mensagens aguardando entrega na fila do EXIM',
  delivered: 'Mensagens entregues com sucesso no período amostrado do log',
  rejected:  'Mensagens rejeitadas (erro 5xx) — recusadas pelo servidor destino',
  deferred:  'Entregas adiadas temporariamente (erro 4xx) — serão retentadas automaticamente',
  sent:      'Mensagens recebidas/aceitas pelo EXIM para envio no período amostrado',
}

// ── Componente principal ─────────────────────────────────────────────────────
export default function Dashboard({ onLogout, onSettings, onServers, onUsers, onActionHistory }) {
  const { isAdmin, username } = useAuth()
  const { activeServer }      = useServer()
  const quick                 = useQuickStatus()
  const full                  = useFullStatus()
  const [refreshing, setRefreshing] = useState(false)
  const [chartKey, setChartKey]     = useState(0)
  const [drawer, setDrawer]         = useState(null)
  const [logViewer, setLogViewer]   = useState(false)

  const q     = quick.data ?? {}
  const f     = full.data  ?? {}
  const diag  = q.diagnosis ?? f.diagnosis ?? {}
  const log   = q.log       ?? f.log       ?? {}
  const queue = q.queue     ?? f.queue     ?? {}

  const hourlyStats        = q.hourly_stats ?? []
  const recommendedActions = diag.actions_recommended ?? []

  // ── Tendência: compara valor atual vs coleta anterior ─────────────────────
  const prevRef = useRef(null)

  const trend = useMemo(() => {
    const prev = prevRef.current
    if (!prev) return {}
    return {
      queue:     (queue.total       ?? 0) - prev.queue,
      delivered: (log.delivered     ?? 0) - prev.delivered,
      rejected:  (log.rejected      ?? 0) - prev.rejected,
      deferred:  (log.deferred      ?? 0) - prev.deferred,
      sent:      (log.recent_sends  ?? 0) - prev.sent,
    }
  }, [quick.data]) // eslint-disable-line

  useEffect(() => {
    if (!quick.loading && quick.data) {
      prevRef.current = {
        queue:     queue.total      ?? 0,
        delivered: log.delivered    ?? 0,
        rejected:  log.rejected     ?? 0,
        deferred:  log.deferred     ?? 0,
        sent:      log.recent_sends ?? 0,
      }
    }
  }, [quick.data]) // eslint-disable-line

  // ── Título dinâmico da aba ────────────────────────────────────────────────
  useEffect(() => {
    const sev   = diag.severity ?? 'OK'
    const icons = { MEDIUM: '⚠️', HIGH: '🚨', CRITICAL: '🔴' }
    const icon  = icons[sev] ?? ''
    document.title = (sev === 'OK' || sev === 'LOW')
      ? 'Mail IQ — AVILI'
      : `${icon} ${sev} — Mail IQ`
    return () => { document.title = 'Mail IQ — AVILI' }
  }, [diag.severity])

  // ── Atalhos de teclado ────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      const tag = e.target.tagName?.toUpperCase()
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        if (!refreshing) handleRefresh()
      }
      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault()
        setLogViewer(v => !v)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [refreshing]) // eslint-disable-line

  // ── Top tables ────────────────────────────────────────────────────────────
  const domainRows = (arr) =>
    (arr ?? []).map(({ domain, count }) => ({ label: domain, count })).filter(r => r.label)

  const topRejected = domainRows(q.top_rejected_domains ?? f.top_rejected_domains)
  const topDeferred = domainRows(q.top_defer_domains    ?? f.top_defer_domains)

  const staleness = useStaleness(q.timestamp)
  const loading   = quick.loading && full.loading

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await refreshStatus()
      await quick.refresh()
      await full.refresh()
    } finally {
      setRefreshing(false)
    }
  }, [quick, full])

  const handleActionComplete = useCallback(() => {
    handleRefresh()
    setChartKey(k => k + 1)
  }, [handleRefresh])

  const topSenders = [
    f.top_sender    && { label: f.top_sender,    count: f.top_sender_count    ?? 0 },
    f.top_recipient && { label: f.top_recipient, count: f.top_recipient_count ?? 0, tag: 'dest' },
    f.relay_suspect && { label: f.relay_suspect, count: f.relay_suspect_send  ?? 0, tag: 'relay' },
  ].filter(Boolean).filter(r => r.label).sort((a, b) => b.count - a.count)

  const topIPs = [
    q.top_ip        && { label: q.top_ip,        count: q.top_ip_count   ?? 0 },
    q.top_auth_user && { label: q.top_auth_user, count: q.top_auth_count ?? 0, tag: 'auth' },
  ].filter(Boolean).filter(r => r.label).sort((a, b) => b.count - a.count)

  // ── Cor do badge de role ──────────────────────────────────────────────────
  const roleStyle = isAdmin
    ? { bg: '#EFF6FF', border: '#BFDBFE', color: '#1D4ED8', label: 'Admin' }
    : { bg: '#F8FAFC', border: '#E2E8F0', color: '#64748B', label: 'Viewer' }

  return (
    <div style={{ minHeight: '100vh', background: '#F1F5F9' }}>

      {/* ── Header ── */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 10,
        padding: '0 24px', background: '#fff',
        borderBottom: '1px solid #E2E8F0',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      }}>
        <div style={{
          maxWidth: 1280, margin: '0 auto',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, height: 54,
        }}>

          {/* ── Esquerda ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, overflow: 'hidden' }}>

            {/* Logo */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <div style={{ width: 34, height: 34, borderRadius: 9, background: '#F0F9FF', border: '1px solid #BAE6FD', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <LogoMark size={19} />
              </div>
              <div className="hidden sm:block" style={{ lineHeight: 1.2 }}>
                <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '-0.01em' }}>
                  <span style={{ color: '#0F172A' }}>Mail </span><span style={{ color: '#0EA5E9' }}>IQ</span>
                </div>
                <div style={{ fontSize: 8.5, letterSpacing: '0.18em', textTransform: 'uppercase', fontWeight: 600, color: '#94A3B8' }}>
                  by <span style={{ color: '#0EA5E9' }}>AVILI</span>
                </div>
              </div>
            </div>

            <span style={{ width: 1, height: 18, background: '#E2E8F0', flexShrink: 0 }} />

            <ServerSelector />

            {/* Badge EXIM */}
            {(() => {
              const sev   = diag.severity ?? 'OK'
              const ok    = sev === 'OK' || sev === 'LOW'
              const color = ok ? '#16A34A' : sev === 'MEDIUM' || sev === 'HIGH' ? '#D97706' : '#DC2626'
              return (
                <StatusPill color={color} label={ok ? 'EXIM' : sev}>
                  <div style={{ fontWeight: 700, color: '#0F172A', marginBottom: 8 }}>Diagnóstico EXIM</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
                    <span style={{ color, fontWeight: 600 }}>{sev}</span>
                  </div>
                  {diag.problem && diag.problem !== 'NORMAL' && (
                    <div style={{ color: '#64748B', fontSize: 11, marginTop: 4 }}>{diag.problem}</div>
                  )}
                </StatusPill>
              )
            })()}

            {/* Badge SSH */}
            {activeServer && (() => {
              const ok    = activeServer.ssh_status === 'ok'
              const color = ok ? '#16A34A' : activeServer.ssh_status === 'unknown' ? '#94A3B8' : '#DC2626'
              return (
                <StatusPill color={color} label="SSH">
                  <div style={{ fontWeight: 700, color: '#0F172A', marginBottom: 8 }}>Conexão SSH</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
                    <span style={{ color, fontWeight: 600 }}>
                      {{ ok: 'Conectado', error: 'Erro', timeout: 'Timeout', unknown: 'Desconhecido' }[activeServer.ssh_status]}
                    </span>
                  </div>
                  {activeServer.ssh_error_msg && (
                    <div style={{ color: '#DC2626', fontSize: 11, marginTop: 4, wordBreak: 'break-word' }}>
                      {activeServer.ssh_error_msg}
                    </div>
                  )}
                  {activeServer.last_connected_at && (
                    <div style={{ color: '#94A3B8', fontSize: 11, marginTop: 4 }}>
                      Último contato: {new Date(activeServer.last_connected_at).toLocaleString('pt-BR')}
                    </div>
                  )}
                </StatusPill>
              )
            })()}

            {/* Staleness */}
            {staleness && (
              <div className="hidden sm:flex items-center gap-1.5" style={{ fontSize: 11, color: staleness.color, flexShrink: 0 }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: staleness.dot, flexShrink: 0 }} />
                {staleness.label}
              </div>
            )}
          </div>

          {/* ── Direita ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>

            {/* Badge usuário + role */}
            {username && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className="hidden md:flex items-center gap-1.5"
                    style={{
                      fontSize: 11, fontWeight: 600,
                      padding: '3px 9px', borderRadius: 999,
                      background: roleStyle.bg,
                      border: `1px solid ${roleStyle.border}`,
                      color: roleStyle.color,
                      flexShrink: 0, whiteSpace: 'nowrap',
                    }}
                  >
                    <span style={{ opacity: 0.7, fontWeight: 400 }}>{username}</span>
                    <span style={{ opacity: 0.35 }}>·</span>
                    <span>{roleStyle.label}</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent>Logado como {username}</TooltipContent>
              </Tooltip>
            )}

            {/* Hint de atalhos */}
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="hidden lg:inline"
                  style={{ fontSize: 9, color: '#CBD5E1', userSelect: 'none', letterSpacing: '0.05em' }}
                >
                  [R] refresh · [L] logs
                </span>
              </TooltipTrigger>
              <TooltipContent>Atalhos de teclado disponíveis</TooltipContent>
            </Tooltip>

            <HBtn onClick={handleRefresh} disabled={refreshing} title="Forçar atualização (R)">
              <RefreshCw size={12} style={{ animation: refreshing ? 'spin 1s linear infinite' : undefined }} />
              <span className="hidden sm:inline">{refreshing ? 'Atualizando…' : 'Refresh'}</span>
            </HBtn>

            <HBtn onClick={() => setLogViewer(true)} title="Visualizador de log (L)">
              <FileText size={12} />
              <span className="hidden sm:inline">Logs</span>
            </HBtn>

            <SettingsMenu
              onSettings={onSettings}
              onServers={onServers}
              onUsers={onUsers}
              onActionHistory={onActionHistory}
              onLogout={onLogout}
              isAdmin={isAdmin}
            />
          </div>
        </div>
      </header>

      {/* ── Banner de erro ── */}
      {(quick.error || full.error) && (
        <div style={{ maxWidth: 1280, margin: '0 auto', padding: '12px 24px 0' }}>
          <div style={{
            borderRadius: 10, padding: '10px 14px', fontSize: 12,
            background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B',
          }}>
            <strong>Erro de conexão:</strong> {quick.error || full.error}
          </div>
        </div>
      )}

      {/* ── Main ── */}
      <main style={{ maxWidth: 1280, margin: '0 auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Métricas */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          <MetricCard
            icon={Inbox}
            label="Fila total"
            value={fmt(queue.total)}
            sub={queue.frozen != null ? `${queue.frozen} frozen` : undefined}
            loading={loading}
            onClick={() => setDrawer('queue')}
            trend={trend.queue}
            trendPositive="down"
            tooltip={METRIC_TOOLTIPS.queue}
          />
          <MetricCard
            icon={CheckCircle}
            label="Entregues"
            value={fmt(log.delivered)}
            sub="no log amostrado"
            loading={loading}
            onClick={() => setDrawer('delivered')}
            trend={trend.delivered}
            trendPositive="up"
            tooltip={METRIC_TOOLTIPS.delivered}
          />
          <MetricCard
            icon={XCircle}
            label="Rejeitados"
            value={fmt(log.rejected)}
            loading={loading}
            onClick={() => setDrawer('rejected')}
            trend={trend.rejected}
            trendPositive="down"
            tooltip={METRIC_TOOLTIPS.rejected}
          />
          <MetricCard
            icon={Clock}
            label="Deferidos"
            value={fmt(log.deferred)}
            loading={loading}
            onClick={() => setDrawer('deferred')}
            trend={trend.deferred}
            trendPositive="down"
            tooltip={METRIC_TOOLTIPS.deferred}
          />
          <MetricCard
            icon={MailOpen}
            label="Recebidos"
            value={fmt(log.recent_sends)}
            loading={loading}
            onClick={() => setDrawer('sent')}
            trend={trend.sent}
            trendPositive="up"
            tooltip={METRIC_TOOLTIPS.sent}
          />
          <DeliveryRateCard
            delivered={log.delivered ?? 0}
            rejected={log.rejected   ?? 0}
            deferred={log.deferred   ?? 0}
            loading={loading}
          />
        </div>

        {/* Diagnóstico */}
        <DiagnosisPanel diagnosis={diag} onAction={handleActionComplete} />

        {/* Tabelas + Ações */}
        <div className={`grid grid-cols-1 sm:grid-cols-2 gap-4 ${isAdmin ? 'lg:grid-cols-3' : ''}`}>
          <TopTable title="Top Remetentes" rows={topSenders} emptyMsg="Disponível no próximo ciclo completo" loading={full.loading}  />
          <TopTable title="Top IPs / Auth"  rows={topIPs}    emptyMsg="Disponível no próximo ciclo completo" loading={quick.loading} />
          {isAdmin && <ActionPanel onActionComplete={handleActionComplete} recommendedActions={recommendedActions} />}
        </div>

        {/* Deliverability — blocklist + SPF/DKIM/DMARC, sob demanda */}
        {isAdmin && (
          <div className="grid grid-cols-1 gap-4">
            <DeliverabilityCard />
          </div>
        )}

        {/* Scripts PHP maliciosos — dado do ciclo completo (5min) */}
        <div className="grid grid-cols-1 gap-4">
          <PhpMailersCard phpMailers={f.php_mailers} loading={full.loading} />
        </div>

        {/* Domínios com erros */}
        {(topRejected.length > 0 || topDeferred.length > 0) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {topRejected.length > 0 && (
              <TopTable
                title="Top Domínios Rejeitados"
                rows={topRejected}
                emptyMsg=""
                loading={false}
                accentColor="red"
              />
            )}
            {topDeferred.length > 0 && (
              <TopTable
                title="Top Domínios Deferidos"
                rows={topDeferred}
                emptyMsg=""
                loading={false}
                accentColor="amber"
              />
            )}
          </div>
        )}

        {/* Gráficos */}
        <div className={hourlyStats.length > 0 ? 'grid grid-cols-1 lg:grid-cols-2 gap-4' : ''}>
          <HistoryChart key={chartKey} />
          {hourlyStats.length > 0 && <HourlyBarChart data={hourlyStats} loading={loading} />}
        </div>

      </main>

      {/* Drawer de mensagens */}
      {drawer && (
        <MessagesDrawer
          cardType={drawer}
          onClose={() => setDrawer(null)}
        />
      )}

      {/* Log Viewer */}
      {logViewer && (
        <LogViewerDrawer onClose={() => setLogViewer(false)} />
      )}
    </div>
  )
}
