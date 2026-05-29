/**
 * Dashboard principal — identidade AVILI light profissional.
 * Estilo admin dashboard: header branco, fundo slate-100, cards brancos com sombra.
 */
import { CheckCircle, Clock, FileText, Inbox, LogOut, MailOpen, RefreshCw, Server, Settings, XCircle } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { refreshStatus } from '../api/client'
import ActionPanel from '../components/ActionPanel'
import DiagnosisPanel from '../components/DiagnosisPanel'
import HistoryChart from '../components/HistoryChart'
import HourlyBarChart from '../components/HourlyBarChart'
import DeliveryRateCard from '../components/DeliveryRateCard'
import MessagesDrawer from '../components/MessagesDrawer'
import LogViewerDrawer from '../components/LogViewerDrawer'
import MetricCard from '../components/MetricCard'
import ServerSelector from '../components/ServerSelector'
import TopTable from '../components/TopTable'
import { useServer } from '../contexts/ServerContext'
import { useFullStatus, useQuickStatus } from '../hooks/useStatus'

function fmt(n) {
  if (n == null) return '—'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1000)      return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

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

/* ── Logo SVG AVILI ── */
function LogoMark({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 60 60" fill="none" aria-hidden>
      <path d="M10 46 L30 16 L50 46" fill="none" stroke="#0F172A" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M18 36 L30 26 L42 36" fill="none" stroke="#0EA5E9" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="30" cy="16" r="2.5" fill="#22D3EE"/>
    </svg>
  )
}


/* ── Botão ícone do header ── */
function IconBtn({ onClick, disabled, title, children, danger }) {
  const [hov, setHov] = useState(false)
  return (
    <button
      onClick={onClick} disabled={disabled} title={title}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        width: 32, height: 32, borderRadius: 7,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: 'none',
        background: hov ? (danger ? '#FEF2F2' : '#F0F9FF') : 'transparent',
        color: hov ? (danger ? '#DC2626' : '#0369A1') : '#94A3B8',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.4 : 1,
        transition: 'all 0.15s',
      }}
    >
      {children}
    </button>
  )
}

/* ── Badge SSH clicável ── */
const SSH_COLOR = { ok: '#16A34A', error: '#DC2626', timeout: '#D97706', unknown: '#94A3B8' }

function SshBadge({ server }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const color = SSH_COLOR[server.ssh_status] ?? '#94A3B8'
  const isOk  = server.ssh_status === 'ok'

  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '3px 9px', borderRadius: 999, fontSize: 11, fontWeight: 600,
          border: `1px solid ${color}30`,
          background: `${color}10`,
          color, cursor: 'pointer',
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
        SSH
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 8px)', left: 0,
          background: '#fff', border: '1px solid #E2E8F0', borderRadius: 10,
          boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
          padding: '12px 14px', minWidth: 220, zIndex: 200,
          fontSize: 12,
        }}>
          <div style={{ fontWeight: 700, color: '#0F172A', marginBottom: 6 }}>
            Conexão SSH
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
            <span style={{ color, fontWeight: 600 }}>
              {{ ok: 'Conectado', error: 'Erro', timeout: 'Timeout', unknown: 'Desconhecido' }[server.ssh_status] ?? server.ssh_status}
            </span>
          </div>
          {server.ssh_error_msg && (
            <div style={{ color: '#DC2626', fontSize: 11, marginBottom: 6, wordBreak: 'break-word' }}>
              {server.ssh_error_msg}
            </div>
          )}
          {server.last_connected_at && (
            <div style={{ color: '#94A3B8', fontSize: 11 }}>
              Último contato: {new Date(server.last_connected_at).toLocaleString('pt-BR')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ── Badge EXIM clicável ── */
const EXIM_COLOR = {
  OK:       '#16A34A',
  LOW:      '#16A34A',
  MEDIUM:   '#D97706',
  HIGH:     '#D97706',
  CRITICAL: '#DC2626',
}

function EximBadge({ severity, problem, staleness }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const sev   = severity ?? 'OK'
  const color = EXIM_COLOR[sev] ?? '#94A3B8'

  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '3px 9px', borderRadius: 999, fontSize: 11, fontWeight: 600,
          border: `1px solid ${color}30`,
          background: `${color}10`,
          color, cursor: 'pointer',
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
        {sev === 'OK' || sev === 'LOW' ? 'EXIM ok' : sev}
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 8px)', left: 0,
          background: '#fff', border: '1px solid #E2E8F0', borderRadius: 10,
          boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
          padding: '12px 14px', minWidth: 220, zIndex: 200,
          fontSize: 12,
        }}>
          <div style={{ fontWeight: 700, color: '#0F172A', marginBottom: 6 }}>
            Diagnóstico EXIM
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
            <span style={{ color, fontWeight: 600 }}>{sev}</span>
          </div>
          {problem && problem !== 'NORMAL' && (
            <div style={{ color: '#64748B', fontSize: 11, marginBottom: 6 }}>{problem}</div>
          )}
          {staleness && (
            <div style={{ color: '#94A3B8', fontSize: 11 }}>
              Dados: {staleness.label}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function Dashboard({ onLogout, onSettings, onServers }) {
  const { activeServer } = useServer()
  const quick = useQuickStatus()
  const full  = useFullStatus()
  const [refreshing, setRefreshing] = useState(false)
  const [chartKey, setChartKey]     = useState(0)
  const [drawer, setDrawer]         = useState(null) // 'queue'|'delivered'|'rejected'|'deferred'|'sent'
  const [logViewer, setLogViewer]   = useState(false)

  const q     = quick.data ?? {}
  const f     = full.data  ?? {}
  const diag  = q.diagnosis ?? f.diagnosis ?? {}
  const log   = q.log       ?? f.log       ?? {}
  const queue = q.queue     ?? f.queue     ?? {}

  const hourlyStats        = q.hourly_stats ?? []
  const eximVersion        = q.exim?.version ?? f.exim?.version ?? null
  const recommendedActions = diag.actions_recommended ?? []

  // Converte {domain, count} → {label, count} para TopTable
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

  return (
    <div style={{ minHeight: '100vh', background: '#F1F5F9' }}>

      {/* ── Header ── */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 10,
        padding: '0 24px',
        background: '#fff',
        borderBottom: '1px solid #E2E8F0',
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      }}>
        <div style={{
          maxWidth: 1280, margin: '0 auto',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          height: 52,
        }}>

          {/* ── Esquerda: logo · servidor · badges ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>

            {/* Logo */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <div style={{
                width: 32, height: 32, borderRadius: 9,
                background: '#F0F9FF', border: '1px solid #BAE6FD',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <LogoMark size={18} />
              </div>
              <div className="hidden sm:block" style={{ lineHeight: 1.2 }}>
                <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: '-0.01em' }}>
                  <span style={{ color: '#0F172A' }}>Mail </span>
                  <span style={{ color: '#0EA5E9' }}>IQ</span>
                </div>
                <div style={{ fontSize: 8, letterSpacing: '0.20em', textTransform: 'uppercase', fontWeight: 600, color: '#CBD5E1' }}>
                  by AVILI
                </div>
              </div>
            </div>

            {/* Divider */}
            <span style={{ width: 1, height: 20, background: '#E2E8F0', flexShrink: 0 }} />

            {/* Seletor de servidor */}
            <ServerSelector />

            {/* Badge SSH */}
            {activeServer && <SshBadge server={activeServer} />}

            {/* Badge EXIM */}
            <EximBadge severity={diag.severity} problem={diag.problem} staleness={staleness} />
          </div>

          {/* ── Direita: ações ── */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
            {/* Refresh */}
            <IconBtn onClick={handleRefresh} disabled={refreshing} title={refreshing ? 'Atualizando…' : 'Atualizar dados'}>
              <RefreshCw size={14} style={{ animation: refreshing ? 'spin 1s linear infinite' : undefined }} />
            </IconBtn>

            {/* Logs */}
            <IconBtn onClick={() => setLogViewer(true)} title="Visualizador de log">
              <FileText size={14} />
            </IconBtn>

            {/* Divider */}
            <span style={{ width: 1, height: 16, background: '#E2E8F0', margin: '0 4px' }} />

            {/* Servidores */}
            <IconBtn onClick={onServers} title="Gerenciar servidores">
              <Server size={14} />
            </IconBtn>

            {/* Configurações */}
            <IconBtn onClick={onSettings} title="Configurações e alertas">
              <Settings size={14} />
            </IconBtn>

            {/* Divider */}
            <span style={{ width: 1, height: 16, background: '#E2E8F0', margin: '0 4px' }} />

            {/* Sair */}
            <IconBtn onClick={onLogout} title="Sair" danger>
              <LogOut size={14} />
            </IconBtn>
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
          <MetricCard icon={Inbox}       label="Fila total"      value={fmt(queue.total)}      sub={queue.frozen != null ? `${queue.frozen} frozen` : undefined} loading={loading} onClick={() => setDrawer('queue')}     />
          <MetricCard icon={CheckCircle} label="Entregues"       value={fmt(log.delivered)}    sub="no log amostrado"   loading={loading} onClick={() => setDrawer('delivered')} />
          <MetricCard icon={XCircle}     label="Rejeitados"      value={fmt(log.rejected)}                              loading={loading} onClick={() => setDrawer('rejected')}  />
          <MetricCard icon={Clock}       label="Deferidos"       value={fmt(log.deferred)}                              loading={loading} onClick={() => setDrawer('deferred')}  />
          <MetricCard icon={MailOpen}    label="Recebidos"       value={fmt(log.recent_sends)}                          loading={loading} onClick={() => setDrawer('sent')}       />
          <DeliveryRateCard
            delivered={log.delivered ?? 0}
            rejected={log.rejected   ?? 0}
            deferred={log.deferred   ?? 0}
            loading={loading}
          />
        </div>

        {/* Diagnóstico */}
        <DiagnosisPanel diagnosis={diag} />

        {/* Tabelas + Ações */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <TopTable title="Top Remetentes" rows={topSenders} emptyMsg="Disponível no próximo ciclo completo" loading={full.loading}  />
          <TopTable title="Top IPs / Auth"  rows={topIPs}    emptyMsg="Disponível no próximo ciclo completo" loading={quick.loading} />
          <ActionPanel onActionComplete={handleActionComplete} recommendedActions={recommendedActions} />
        </div>

        {/* Domínios com erros — só aparece se houver dados */}
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

      {/* ── Drawer de mensagens ── */}
      {drawer && (
        <MessagesDrawer
          cardType={drawer}
          onClose={() => setDrawer(null)}
        />
      )}

      {/* ── Log Viewer ── */}
      {logViewer && (
        <LogViewerDrawer onClose={() => setLogViewer(false)} />
      )}
    </div>
  )
}
