/**
 * Dashboard principal — identidade visual AVILI light.
 *
 * Header com accent line sky-blue, logo SVG AVILI, "Um produto de Avili".
 * Fundo claro #EEF2F7, glass cards brancos, texto #0F1A2E.
 * Sem emojis. Lucide icons. Paleta sky-500 / cyan-500.
 */
import { AlertTriangle, CheckCircle, Clock, Inbox, LogOut, RefreshCw, Send, Settings, XCircle } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { refreshStatus } from '../api/client'
import ActionPanel from '../components/ActionPanel'
import DiagnosisPanel from '../components/DiagnosisPanel'
import HistoryChart from '../components/HistoryChart'
import HourlyBarChart from '../components/HourlyBarChart'
import MetricCard from '../components/MetricCard'
import StatusBadge from '../components/StatusBadge'
import TopTable from '../components/TopTable'
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
    const id = setInterval(() => tick((n) => n + 1), 10_000)
    return () => clearInterval(id)
  }, [])
  if (!ts) return null
  const diffS = Math.floor((Date.now() - new Date(ts).getTime()) / 1000)
  if (diffS < 60)  return { color: '#0EA5E9', dot: '#0EA5E9', label: `${diffS}s atrás`,                           pulse: false }
  if (diffS < 300) return { color: '#D97706', dot: '#FBBF24', label: `${Math.floor(diffS/60)}min atrás`,          pulse: false }
  return               { color: '#DC2626', dot: '#EF4444', label: `${Math.floor(diffS/60)}min · desatualizado`, pulse: true  }
}

/* ── Logo SVG AVILI — traços escuros para fundo claro ── */
function LogoMark({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 60 60" fill="none" aria-hidden>
      <path d="M10 46 L30 16 L50 46" fill="none" stroke="#0F1A2E" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M18 36 L30 26 L42 36" fill="none" stroke="#0EA5E9" strokeWidth="3"   strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx="30" cy="16" r="2.5" fill="#22D3EE"/>
    </svg>
  )
}

/* ── Botão header ghost light ── */
function HBtn({ onClick, disabled, title, children, danger }) {
  const [hov, setHov] = useState(false)
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        borderRadius: 10,
        border: hov
          ? (danger ? '1px solid rgba(239,68,68,0.45)' : '1px solid rgba(14,165,233,0.40)')
          : '1px solid rgba(15,26,46,0.12)',
        padding: '6px 12px', fontSize: 11, fontWeight: 500, cursor: 'pointer',
        color: hov ? (danger ? '#DC2626' : '#0369A1') : 'rgba(15,26,46,0.50)',
        background: hov
          ? (danger ? 'rgba(239,68,68,0.07)' : 'rgba(14,165,233,0.08)')
          : 'transparent',
        transition: 'all 0.15s',
        opacity: disabled ? 0.4 : 1,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  )
}

export default function Dashboard({ onLogout, onSettings }) {
  const quick = useQuickStatus()
  const full  = useFullStatus()
  const [refreshing, setRefreshing] = useState(false)
  const [chartKey, setChartKey]     = useState(0)

  const q     = quick.data ?? {}
  const f     = full.data  ?? {}
  const diag  = q.diagnosis  ?? f.diagnosis  ?? {}
  const log   = q.log        ?? f.log        ?? {}
  const queue = q.queue      ?? f.queue      ?? {}

  // v4.9 — novos campos
  const hourlyStats  = q.hourly_stats ?? []
  const phpMailers   = f.php_mailers  ?? null
  const eximVersion  = q.exim?.version ?? f.exim?.version ?? null

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
    setChartKey((k) => k + 1)
  }, [handleRefresh])

  // TopTable — remetentes
  const topSenders = [
    f.top_sender    && { label: f.top_sender,    count: f.top_sender_count    ?? 0 },
    f.top_recipient && { label: f.top_recipient, count: f.top_recipient_count ?? 0, tag: 'dest' },
    f.relay_suspect && { label: f.relay_suspect, count: f.relay_suspect_send  ?? 0, tag: 'relay' },
  ].filter(Boolean).filter(r => r.label).sort((a, b) => b.count - a.count)

  // TopTable — IPs / auth
  const topIPs = [
    q.top_ip        && { label: q.top_ip,        count: q.top_ip_count   ?? 0 },
    q.top_auth_user && { label: q.top_auth_user, count: q.top_auth_count ?? 0, tag: 'auth' },
  ].filter(Boolean).filter(r => r.label).sort((a, b) => b.count - a.count)

  return (
    <div style={{ minHeight: '100vh', color: 'var(--text)' }}>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <header
        className="header-accent"
        style={{
          position: 'sticky', top: 0, zIndex: 10,
          padding: '0 24px',
          borderBottom: '1px solid rgba(14,165,233,0.14)',
          background: 'rgba(238,242,247,0.85)',
          backdropFilter: 'blur(24px)',
          WebkitBackdropFilter: 'blur(24px)',
          boxShadow: '0 1px 12px rgba(14,100,180,0.06)',
        }}
      >
        <div style={{ maxWidth: 1280, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, height: 54 }}>

          {/* Esquerda */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
            {/* Logo AVILI */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
              <div style={{
                width: 34, height: 34, borderRadius: 10,
                background: 'rgba(255,255,255,0.80)',
                border: '1px solid rgba(14,165,233,0.22)',
                boxShadow: '0 2px 8px rgba(14,100,180,0.10)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <LogoMark size={20} />
              </div>
              <div className="hidden sm:block" style={{ lineHeight: 1.1 }}>
                <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: '0.10em', color: '#0F1A2E', display: 'block' }}>
                  EXIM Monitor
                </span>
                <span style={{ fontSize: 9, letterSpacing: '0.20em', textTransform: 'uppercase', color: '#0EA5E9', fontWeight: 500 }}>
                  Um produto de Avili
                </span>
              </div>
            </div>

            {/* Divider */}
            <span style={{ color: 'rgba(15,26,46,0.15)', fontSize: 16, flexShrink: 0 }} className="hidden md:block">|</span>

            {/* Hostname + versão Exim */}
            {(q.hostname || f.hostname) && (
              <div className="hidden md:flex items-center gap-2 min-w-0">
                <span
                  className="truncate font-mono"
                  style={{ fontSize: 11, color: 'rgba(15,26,46,0.35)' }}
                >
                  {q.hostname || f.hostname}
                </span>
                {eximVersion && eximVersion !== 'unknown' && (
                  <span style={{
                    fontSize: 9, fontWeight: 600, letterSpacing: '0.07em',
                    padding: '2px 7px', borderRadius: 20,
                    background: 'rgba(14,165,233,0.10)',
                    border: '1px solid rgba(14,165,233,0.22)',
                    color: '#0369A1', flexShrink: 0,
                  }}>
                    Exim {eximVersion}
                  </span>
                )}
              </div>
            )}

            {/* Status badge */}
            <StatusBadge severity={diag.severity ?? 'OK'} problem={diag.problem} />

            {/* Staleness */}
            {staleness && (
              <div
                className="hidden sm:flex items-center gap-1.5"
                style={{ fontSize: 11, color: staleness.color }}
              >
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: staleness.dot, flexShrink: 0,
                  animation: staleness.pulse ? 'pulse-sky 2s ease-in-out infinite' : undefined,
                }} />
                {staleness.label}
              </div>
            )}
          </div>

          {/* Direita — botões */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <HBtn onClick={handleRefresh} disabled={refreshing} title="Forçar atualização">
              <RefreshCw size={12} style={{ animation: refreshing ? 'spin 1s linear infinite' : undefined }} />
              <span className="hidden sm:inline">{refreshing ? 'Atualizando…' : 'Refresh'}</span>
            </HBtn>

            <HBtn onClick={onSettings} title="Configurações de alertas">
              <Settings size={12} />
              <span className="hidden sm:inline">Alertas</span>
            </HBtn>

            <HBtn onClick={onLogout} title="Sair" danger>
              <LogOut size={12} />
              <span className="hidden sm:inline">Sair</span>
            </HBtn>
          </div>
        </div>
      </header>

      {/* ── Banner de erro ──────────────────────────────────────────────────── */}
      {(quick.error || full.error) && (
        <div style={{ maxWidth: 1280, margin: '0 auto', padding: '16px 24px 0' }}>
          <div style={{
            borderRadius: 12, padding: '12px 16px', fontSize: 12,
            background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.25)',
            color: '#DC2626', backdropFilter: 'blur(8px)',
          }}>
            <strong>Erro de conexão:</strong> {quick.error || full.error}
          </div>
        </div>
      )}

      {/* ── Conteúdo principal ──────────────────────────────────────────────── */}
      <main style={{ maxWidth: 1280, margin: '0 auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* Row 1 — Métricas */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <MetricCard icon={Inbox}       label="Fila total"       value={fmt(queue.total)}      sub={queue.frozen != null ? `${queue.frozen} frozen` : undefined} loading={loading} />
          <MetricCard icon={CheckCircle} label="Entregues"        value={fmt(log.delivered)}    sub="no log amostrado" loading={loading} />
          <MetricCard icon={XCircle}     label="Rejeitados"       value={fmt(log.rejected)}     loading={loading} />
          <MetricCard icon={Clock}       label="Deferidos"        value={fmt(log.deferred)}     loading={loading} />
          <MetricCard icon={Send}        label="Envios recentes"  value={fmt(log.recent_sends)} loading={loading} />
        </div>

        {/* Row 2 — Diagnóstico */}
        <DiagnosisPanel diagnosis={diag} />

        {/* Row 3 — Tráfego por hora (hourly_stats do --quick, v4.9) */}
        {(hourlyStats.length > 0 || quick.loading) && (
          <HourlyBarChart data={hourlyStats} loading={quick.loading && hourlyStats.length === 0} />
        )}

        {/* Row 3b — Alerta PHP mailer (php_mailers do --json, v4.9) */}
        {phpMailers && phpMailers.suspicious > 0 && (
          <div style={{
            borderRadius: 12, padding: '12px 16px',
            background: 'rgba(234,179,8,0.08)',
            border: '1px solid rgba(234,179,8,0.30)',
            display: 'flex', alignItems: 'flex-start', gap: 10,
          }}>
            <AlertTriangle size={15} style={{ color: '#D97706', flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 12, lineHeight: 1.6 }}>
              <span style={{ fontWeight: 600, color: '#92400E' }}>
                PHP mailer suspeito detectado
              </span>
              <span style={{ color: 'rgba(15,26,46,0.55)' }}>
                {' '}— {phpMailers.suspicious} arquivo{phpMailers.suspicious > 1 ? 's' : ''} com padrões de ofuscação
                {phpMailers.mail_calls > 0 ? `, ${phpMailers.mail_calls} com mail()` : ''}.
              </span>
              {phpMailers.top_suspect && (
                <span
                  className="block font-mono mt-0.5"
                  style={{ fontSize: 10, color: '#D97706', wordBreak: 'break-all' }}
                >
                  {phpMailers.top_suspect}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Row 4 — Tabelas + Ações */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <TopTable title="Top Remetentes"  rows={topSenders} emptyMsg="Disponível no próximo ciclo completo" loading={full.loading}  />
          <TopTable title="Top IPs / Auth"  rows={topIPs}     emptyMsg="Disponível no próximo ciclo completo" loading={quick.loading} />
          <ActionPanel onActionComplete={handleActionComplete} />
        </div>

        {/* Row 5 — Histórico de snapshots */}
        <HistoryChart key={chartKey} />

      </main>
    </div>
  )
}
