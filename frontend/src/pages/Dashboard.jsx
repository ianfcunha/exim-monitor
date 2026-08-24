/**
 * Dashboard principal — identidade AVILI light profissional.
 * Estilo admin dashboard: header branco, fundo slate-100, cards brancos com sombra.
 *
 * Melhorias UX incluídas:
 *   - Título dinâmico da aba conforme severidade
 *   - Tendência nos MetricCards (seta ↑↓ vs coleta anterior)
 *   - Tooltips explicativos nos cards
 *   - DiagnosisPanel colapsável (auto-colapsa em OK, auto-expande em CRITICAL)
 *
 * Sessão 3, T6 — "poda": este é o Painel clássico agora, secundário à
 * Triagem (/triage). PHP mailer detector, gráficos históricos, log
 * viewer, badge de role (Admin/Viewer) e os atalhos R=Refresh/L=Logs só
 * aparecem com `advanced` ligado (Configurações → Geral → Modo
 * avançado, desligado por padrão — ver useAdvancedMode.js) — nenhum
 * deles foi removido, só deixaram de ser o caminho principal/de demo.
 */
import {
  CheckCircle, Clock, FileText, History, Inbox,
  LayoutGrid, MailOpen, RefreshCw, XCircle,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchServerHealth, refreshStatus } from '../api/client'
import { Button } from '@/components/ui/button'
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
import HealthSeal from '../components/HealthSeal'
import TopTable from '../components/TopTable'
import { useAuth } from '../contexts/AuthContext'
import { useServer } from '../contexts/ServerContext'
import { useFullStatus, useQuickStatus } from '../hooks/useStatus'
import { severityLabel } from '../lib/severity'

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
  if (diffS < 60)  return { color: 'var(--sky)', dot: 'var(--sky)', label: `${diffS}s atrás`,                         pulse: false }
  if (diffS < 300) return { color: 'var(--warn)', dot: 'var(--warn)', label: `${Math.floor(diffS/60)}min atrás`,        pulse: false }
  return               { color: 'var(--danger)', dot: 'var(--danger)', label: `${Math.floor(diffS/60)}min · desatualizado`, pulse: true  }
}

// ── Botão da barra da página ─────────────────────────────────────────────────
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



// ── Tooltips por métrica ─────────────────────────────────────────────────────
const METRIC_TOOLTIPS = {
  queue:     'Total de mensagens aguardando entrega na fila do EXIM',
  delivered: 'Mensagens entregues com sucesso no período amostrado do log',
  rejected:  'Mensagens rejeitadas (erro 5xx) — recusadas pelo servidor destino',
  deferred:  'Entregas adiadas temporariamente (erro 4xx) — serão retentadas automaticamente',
  sent:      'Mensagens recebidas/aceitas pelo EXIM para envio no período amostrado',
}

// ── Escolha de servidor (Sessão 5) ───────────────────────────────────────────
// Esta aba é intrinsecamente de UM servidor: a fila é dele, o
// diagnóstico é dele, e as ações agem nele. Em "Toda a frota" ela
// mostrava um servidor só, sem dizer qual — o backend caía no primeiro
// da lista calado — enquanto o painel de ações desenhava os botões com
// as permissões do contexto vazio: destrutivos, habilitados, sem alvo
// identificado. Escolher por conta própria era o defeito; pedir a
// escolha é a correção.
function ChooseServer({ servers, onPick }) {
  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '48px 24px', width: '100%' }}>
      <div style={{
        background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
        padding: '28px 24px', textAlign: 'center', maxWidth: 520, margin: '0 auto',
      }}>
        <LayoutGrid size={22} color="var(--dim)" style={{ marginBottom: 10 }} />
        <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: '0 0 6px' }}>
          A Fila é por servidor
        </p>
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 18px', lineHeight: 1.55 }}>
          Fila, diagnóstico e ações agem sobre um servidor específico — não há
          como somá-los na frota sem esconder de qual servidor é cada número.
          Para uma visão de toda a frota, use a <strong>Triagem</strong>.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          {servers.map(s => (
            <Button key={s.id} size="sm" variant="outline" onClick={() => onPick(s)}>
              {s.name}
            </Button>
          ))}
        </div>
      </div>
    </div>
  )
}

// ── Componente principal ─────────────────────────────────────────────────────
export default function Dashboard({ advanced = false }) {
  const { isAdmin } = useAuth()
  const { activeServer, isFleet, servers, setActiveServer } = useServer()
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

  // ── Selo de saúde — a única fonte do veredito ─────────────────────────────
  // Sessão 5: buscado AQUI e passado ao HealthSeal, em vez de o selo
  // buscar por conta própria, porque o título da aba precisa do mesmo
  // valor. Sem isso havia três representações do estado do servidor na
  // mesma tela — selo (incidentes), painel DIAGNÓSTICO (severity da
  // coleta) e título da aba (severity da coleta) — e as duas últimas
  // divergiam da primeira. health.py é a fonte única desde a T5.
  const [health, setHealth] = useState(null)
  useEffect(() => {
    if (!activeServer) { setHealth(null); return }
    let alive = true
    const load = () => fetchServerHealth(activeServer.id)
      .then(h => { if (alive) setHealth(h) })
      .catch(() => { if (alive) setHealth(null) })
    load()
    const id = setInterval(load, 30_000)
    return () => { alive = false; clearInterval(id) }
  }, [activeServer])

  // ── Título dinâmico da aba ────────────────────────────────────────────────
  useEffect(() => {
    // O ícone e a palavra vêm do estado de saúde (health.py), não do
    // `severity` do último snapshot: o snapshot é a leitura crua de uma
    // coleta, o selo é o veredito depois da histerese. A aba dizia
    // "🔴 CRÍTICO — Mail IQ" enquanto o selo, a dois centímetros dali,
    // dizia entrega normal.
    // "indeterminado" não ganha ícone de alerta — é "ainda não sei",
    // não "algo está errado" — mas também não finge OK.
    const icons = { critico: '🔴', atencao: '⚠️' }
    const state = health?.state
    document.title = (!state || state === 'ok' || state === 'indeterminado')
      ? 'Mail IQ — AVILI'
      : `${icons[state] ?? ''} ${severityLabel(state)} — Mail IQ`
    return () => { document.title = 'Mail IQ — AVILI' }
  }, [health?.state])

  // ── Atalhos de teclado ────────────────────────────────────────────────────
  // Sessão 3, T6 — "poda": atalhos fora da Triagem só existem em modo
  // avançado. A Triagem (J/K/E/S) é a única história de atalhos que
  // aparece por padrão, sem um segundo conjunto concorrente aqui.
  useEffect(() => {
    if (!advanced) return
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
  }, [refreshing, advanced]) // eslint-disable-line

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

  // Frota com mais de um servidor: pede a escolha em vez de exibir um
  // servidor sem nome. Depois de todos os hooks — a ordem deles não pode
  // depender deste ramo.
  if (!activeServer && isFleet && servers.length > 1) {
    return (
      <div style={{ background: 'var(--surface)' }}>
        <ChooseServer servers={servers} onPick={setActiveServer} />
      </div>
    )
  }

  return (
    <div style={{ background: 'var(--surface)' }}>

      {/* ── Barra da página ──
          Sessão 4, T8: o cabeçalho (logo, seletor de servidor,
          navegação, usuário) vive agora na casca única — AppShell.jsx.
          Aqui fica só o que é específico desta aba: o selo de saúde
          (mesma fonte da Triagem, T5) e os controles da coleta. */}
      <div style={{ maxWidth: 1280, margin: '0 auto', padding: '16px 24px 0', width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <HealthSeal health={health} />
          {staleness && (
            <div className="hidden sm:flex items-center gap-1.5" style={{ fontSize: 11, color: staleness.color }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: staleness.dot }} />
              {staleness.label}
            </div>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <HBtn onClick={handleRefresh} disabled={refreshing} title="Forçar uma nova coleta agora">
              <RefreshCw size={12} style={{ animation: refreshing ? 'spin 1s linear infinite' : undefined }} />
              <span className="hidden sm:inline">{refreshing ? 'Atualizando…' : 'Atualizar'}</span>
            </HBtn>
            {advanced && (
              <HBtn onClick={() => setLogViewer(true)} title="Abrir o visualizador de log">
                <FileText size={12} />
                <span className="hidden sm:inline">Logs</span>
              </HBtn>
            )}
          </div>
        </div>
      </div>

      {/* ── Banner de erro ── */}
      {(quick.error || full.error) && (
        <div style={{ maxWidth: 1280, margin: '0 auto', padding: '12px 24px 0' }}>
          <div style={{
            borderRadius: 10, padding: '10px 14px', fontSize: 12,
            background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', color: 'var(--danger)',
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
        <DiagnosisPanel diagnosis={diag} sealState={health?.state ?? null} />

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

        {/* Scripts PHP maliciosos — dado do ciclo completo (5min).
            Sessão 3, T6: fica atrás do modo avançado — "uma demo com
            cinco painéis dilui; uma demo com um incidente real
            detectado convence". */}
        {advanced && (
          <div className="grid grid-cols-1 gap-4">
            <PhpMailersCard phpMailers={f.php_mailers} loading={full.loading} />
          </div>
        )}

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

        {/* Gráficos históricos elaborados — Sessão 3, T6: modo avançado */}
        {advanced && (
          <div className={hourlyStats.length > 0 ? 'grid grid-cols-1 lg:grid-cols-2 gap-4' : ''}>
            <HistoryChart key={chartKey} />
            {hourlyStats.length > 0 && <HourlyBarChart data={hourlyStats} loading={loading} />}
          </div>
        )}

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
