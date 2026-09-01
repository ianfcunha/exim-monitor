/**
 * Métricas — Sessão 6, handoff Mail IQ 2.0.
 *
 * Volume de fila e taxa de entrega nas últimas horas, com KPIs de
 * resumo. Fonte: GET /api/history (Snapshot — mesma série que
 * HistoryChart.jsx, no "modo avançado" do painel clássico), agora numa
 * tela própria, com os cartões de resumo do handoff.
 *
 * O mockup mostra "toda a frota" numa linha só; a série real é POR
 * SERVIDOR (Snapshot.server_id) — somar servidores diferentes no mesmo
 * ponto do tempo sem agregação por timestamp seria um gráfico
 * enganoso. Segue o mesmo padrão já usado na Fila (Sessão 5): com mais
 * de um servidor cadastrado e nenhum selecionado, pede a escolha em vez
 * de inventar uma agregação.
 *
 * Sessão 6 / retorno #2 — a tela ganhou o que o diag-exim.sh já coleta e
 * não aparecia em lugar nenhum: o funil de entrega (onde o e-mail se
 * perde, não só a taxa final), as tabelas de "top ofensores do momento"
 * (maior remetente/destino, domínios que mais adiam/rejeitam), os
 * recursos do Exim (recolhidos por padrão) e o Log Viewer embutido,
 * agora com escopo de servidor — antes o visualizador de log só existia
 * atrás do "modo avançado" do painel clássico e chamava /messages/tail
 * sem server_id.
 */
import {
  ChevronDown, Copy, Cpu, Download, LayoutGrid, RefreshCw, ScrollText, Search as SearchIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { exportLogMessages, fetchFullStatus, fetchHistory, fetchLogTail } from '../api/client'
import { Button } from '@/components/ui/button'
import { useServer } from '../contexts/ServerContext'

const isoDaysAgo = (n) => {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

const PERIODS = [
  { key: '6h', hours: 6 }, { key: '24h', hours: 24 }, { key: '7d', hours: 168 },
]
const CRIT_SEVERITIES = new Set(['CRITICAL', 'HIGH', 'DEGRADED'])

// Funil de entrega — cor semântica, não a paleta --sky do volume.
const FUNNEL_SERIES = [
  { key: 'Entregue',  color: 'var(--ok)' },
  { key: 'Adiado',    color: 'var(--warn)' },
  { key: 'Rejeitado', color: 'var(--danger)' },
  { key: 'Erro DNS',  color: 'var(--dim)' },
]

// Cores por tipo de linha do log — mesma linguagem do LogViewerDrawer.
const LOG_TYPE = {
  delivered: { label: 'Entregues', color: 'var(--ok)',     dot: 'var(--ok)' },
  rejected:  { label: 'Rejeitados', color: 'var(--danger)', dot: 'var(--danger)' },
  deferred:  { label: 'Adiados',    color: 'var(--warn)',   dot: 'var(--warn)' },
  sent:      { label: 'Enviados',   color: 'var(--sky)',    dot: 'var(--sky)' },
  other:     { label: 'Outros',     color: 'var(--muted)',  dot: 'var(--dim)' },
}
const LOG_LIMITS = [100, 200, 300, 500]

function fmtTimeShort(iso, hours) {
  const d = new Date(iso)
  return hours > 24
    ? d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit' })
    : d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

function ChooseServer({ servers, onPick }) {
  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '48px 24px', width: '100%' }}>
      <div style={{
        background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
        padding: '28px 24px', textAlign: 'center', maxWidth: 520, margin: '0 auto',
      }}>
        <LayoutGrid size={22} color="var(--dim)" style={{ marginBottom: 10 }} />
        <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: '0 0 6px' }}>
          Métricas são por servidor
        </p>
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 18px', lineHeight: 1.55 }}>
          Volume de fila e taxa de entrega são séries de um servidor específico —
          somar servidores diferentes no mesmo gráfico esconderia de qual é cada pico.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
          {servers.map(s => (
            <Button key={s.id} size="sm" variant="outline" onClick={() => onPick(s)}>{s.name}</Button>
          ))}
        </div>
      </div>
    </div>
  )
}

function Kpi({ label, value, sub, color = 'var(--text)' }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px' }}>
      <div style={{ fontSize: 11, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, marginBottom: 5 }}>{label}</div>
      <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 26, fontWeight: 700, color, letterSpacing: '-0.02em', lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--dim)', marginTop: 4 }}>{sub}</div>}
    </div>
  )
}

function ChartCard({ title, sub, badge, legend, children }) {
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '22px 24px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{title}</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{sub}</span>
        {legend && (
          <div style={{ display: 'flex', gap: 12, marginLeft: badge ? 0 : 'auto', flexWrap: 'wrap' }}>
            {legend.map(l => (
              <span key={l.key} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--muted)' }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: l.color }} /> {l.key}
              </span>
            ))}
          </div>
        )}
        {badge && (
          <span style={{
            marginLeft: 'auto', fontSize: 11.5, fontWeight: 600, color: 'var(--danger)',
            background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', borderRadius: 999, padding: '2px 9px',
          }}>
            {badge}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}

const chartTooltip = {
  contentStyle: { background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 11.5 },
  labelStyle: { color: 'var(--muted)' },
}

// ── Tabela de "top ofensores" — um par rótulo/contagem, ou uma lista ────
function OffenderTable({ title, rows, empty }) {
  if (!rows || rows.length === 0) {
    return (
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px' }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>{title}</div>
        <div style={{ fontSize: 11.5, color: 'var(--dim)' }}>{empty ?? 'Sem dados neste ciclo.'}</div>
      </div>
    )
  }
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '16px 18px' }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>{title}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5 }}>
            <span style={{
              flex: 1, minWidth: 0, color: 'var(--text)', fontFamily: "'JetBrains Mono', monospace",
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }} title={r.label}>
              {r.label}
            </span>
            {r.count != null && (
              <span style={{ flexShrink: 0, fontWeight: 700, color: 'var(--muted)', fontFamily: "'JetBrains Mono', monospace" }}>
                {Number(r.count).toLocaleString('pt-BR')}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Recursos do Exim — recolhido por padrão (pedido do cliente): quem
// quiser inspecionar clica e abre. ────────────────────────────────────
function EximResources({ snap }) {
  const [open, setOpen] = useState(false)
  const exim = snap?.exim ?? {}
  const log = snap?.log ?? {}
  const dist = snap?.queue?.size_distribution ?? {}

  const items = [
    { label: 'Processos exim', value: exim.processes ?? '—' },
    { label: 'CPU total', value: exim.cpu_total != null ? `${exim.cpu_total}%` : '—' },
    { label: 'Memória total', value: exim.mem_total != null ? `${exim.mem_total}%` : '—' },
    { label: 'Uptime do exim', value: exim.uptime ?? '—' },
    { label: 'Versão', value: exim.version ?? snap?.version ?? '—' },
    { label: 'Tamanho do mainlog', value: log.mainlog_size_mb != null ? `${log.mainlog_size_mb} MB` : '—' },
    { label: 'Reconhecimento do log', value: log.recognition_pct != null ? `${log.recognition_pct}%` : '—' },
    { label: 'Mensagens > 1 MB na fila', value: dist.over_1mb ?? '—' },
    { label: 'Mensagens > 5 MB na fila', value: dist.over_5mb ?? '—' },
  ]

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '16px 20px',
          background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left',
        }}
      >
        <Cpu size={14} color="var(--muted)" />
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', flex: 1 }}>Recursos do Exim</span>
        <span style={{ fontSize: 11.5, color: 'var(--dim)' }}>{open ? 'ocultar' : 'ver detalhes'}</span>
        <ChevronDown size={14} color="var(--dim)" style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
      </button>
      {open && (
        <div style={{
          padding: '4px 20px 18px', display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 12,
        }}>
          {items.map(it => (
            <div key={it.label}>
              <div style={{ fontSize: 10, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 3 }}>{it.label}</div>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', fontFamily: "'JetBrains Mono', monospace" }}>{String(it.value)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Log Viewer embutido — tail do mainlog COM escopo de servidor ────────
function InlineLogViewer({ serverId }) {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [limit, setLimit]     = useState(200)
  const [filter, setFilter]   = useState('all')
  const [q, setQ]             = useState('')
  const [auto, setAuto]       = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [copied, setCopied]   = useState(null)
  const timer = useRef(null)

  const [showExport, setShowExport]     = useState(false)
  const [exportStart, setExportStart]   = useState(() => isoDaysAgo(7))
  const [exportEnd, setExportEnd]       = useState(() => isoDaysAgo(0))
  const [exportAccount, setExportAccount] = useState('')
  const [exportFormat, setExportFormat] = useState('csv')
  const [exporting, setExporting]       = useState(false)
  const [exportError, setExportError]   = useState(null)

  const handleExport = async () => {
    setExporting(true)
    setExportError(null)
    try {
      const params = { start: exportStart, end: exportEnd, format: exportFormat }
      if (exportAccount.trim()) params.account = exportAccount.trim()
      if (filter !== 'all') params.type = filter
      const res = await exportLogMessages(params, serverId ?? null)
      const cd = res.headers?.['content-disposition'] ?? ''
      const match = cd.match(/filename="?([^"]+)"?/)
      const filename = match?.[1] ?? `exim-log_${exportStart}_${exportEnd}.${exportFormat}`
      const url = window.URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      window.URL.revokeObjectURL(url)
      setShowExport(false)
    } catch (e) {
      let msg = e?.message ?? 'Erro ao exportar log.'
      const data = e?.response?.data
      if (data instanceof Blob) {
        try { msg = JSON.parse(await data.text())?.detail ?? msg } catch { /* corpo não-JSON */ }
      } else if (data?.detail) {
        msg = data.detail
      }
      setExportError(msg)
    } finally {
      setExporting(false)
    }
  }

  const load = useCallback((spin = false) => {
    if (spin) setRefreshing(true)
    setError(null)
    fetchLogTail(limit, serverId ?? null)
      .then(setEntries)
      .catch(e => setError(e?.response?.data?.detail ?? e.message ?? 'Erro ao carregar o log.'))
      .finally(() => { setLoading(false); setRefreshing(false) })
  }, [limit, serverId])

  useEffect(() => { setLoading(true); load() }, [load])
  useEffect(() => {
    clearInterval(timer.current)
    if (auto) timer.current = setInterval(() => load(), 15_000)
    return () => clearInterval(timer.current)
  }, [auto, load])

  const counts = useMemo(() => {
    const c = { all: entries.length }
    for (const e of entries) c[e.type] = (c[e.type] ?? 0) + 1
    return c
  }, [entries])

  const visible = entries.filter(e => {
    if (filter !== 'all' && e.type !== filter) return false
    if (q && !e.raw.toLowerCase().includes(q.toLowerCase())) return false
    return true
  })

  const copy = (text, i) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(i); setTimeout(() => setCopied(null), 1200)
    })
  }

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '14px 18px', flexWrap: 'wrap' }}>
        <ScrollText size={14} color="var(--muted)" />
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>Log Viewer</span>
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>últimas linhas do mainlog</span>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ position: 'relative' }}>
            <SearchIcon size={12} color="var(--dim)" style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)' }} />
            <input
              value={q} onChange={e => setQ(e.target.value)} placeholder="filtrar…"
              style={{
                width: 150, boxSizing: 'border-box', padding: '5px 8px 5px 24px', fontSize: 11.5,
                borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', outline: 'none',
              }}
            />
          </div>
          <select
            value={limit} onChange={e => setLimit(Number(e.target.value))}
            style={{ fontSize: 11.5, padding: '5px 6px', borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
          >
            {LOG_LIMITS.map(n => <option key={n} value={n}>{n} linhas</option>)}
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--muted)', cursor: 'pointer', userSelect: 'none' }}>
            <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} style={{ accentColor: 'var(--sky)' }} />
            auto
          </label>
          <button
            onClick={() => setShowExport(v => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: 5, height: 28, padding: '0 9px', fontSize: 11.5,
              borderRadius: 7, cursor: 'pointer',
              border: `1px solid ${showExport ? 'var(--accent-border)' : 'var(--border)'}`,
              background: showExport ? 'var(--accent-bg)' : 'var(--surface)',
              color: showExport ? 'var(--accent-fg)' : 'var(--muted)',
            }}
          >
            <Download size={12} /> Exportar
          </button>
          <button
            onClick={() => load(true)} disabled={refreshing}
            style={{ width: 28, height: 28, borderRadius: 7, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <RefreshCw size={12} style={{ animation: refreshing ? 'spin 1s linear infinite' : undefined }} />
          </button>
        </div>
      </div>

      {showExport && (
        <div style={{
          margin: '0 18px 12px', padding: '12px 14px', borderRadius: 9,
          border: '1px solid var(--border)', background: 'var(--surface)',
          display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 10,
        }}>
          <label style={{ fontSize: 10.5, color: 'var(--muted)', display: 'flex', flexDirection: 'column', gap: 3 }}>
            De
            <input type="date" value={exportStart} max={exportEnd}
              onChange={e => setExportStart(e.target.value)}
              style={{ fontSize: 11.5, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text)' }} />
          </label>
          <label style={{ fontSize: 10.5, color: 'var(--muted)', display: 'flex', flexDirection: 'column', gap: 3 }}>
            Até
            <input type="date" value={exportEnd} min={exportStart} max={isoDaysAgo(0)}
              onChange={e => setExportEnd(e.target.value)}
              style={{ fontSize: 11.5, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text)' }} />
          </label>
          <label style={{ fontSize: 10.5, color: 'var(--muted)', display: 'flex', flexDirection: 'column', gap: 3 }}>
            Conta (opcional)
            <input type="text" placeholder="usuario@dominio.com" value={exportAccount}
              onChange={e => setExportAccount(e.target.value)}
              style={{ width: 170, fontSize: 11.5, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text)' }} />
          </label>
          <label style={{ fontSize: 10.5, color: 'var(--muted)', display: 'flex', flexDirection: 'column', gap: 3 }}>
            Formato
            <select value={exportFormat} onChange={e => setExportFormat(e.target.value)}
              style={{ fontSize: 11.5, padding: '4px 6px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text)' }}>
              <option value="csv">CSV</option>
              <option value="txt">TXT</option>
            </select>
          </label>
          <button
            onClick={handleExport} disabled={exporting}
            style={{
              display: 'flex', alignItems: 'center', gap: 5, height: 28, padding: '0 12px', fontSize: 11.5, fontWeight: 600,
              borderRadius: 7, border: '1px solid var(--accent-border)', background: 'var(--accent-bg)', color: 'var(--accent-fg)',
              cursor: exporting ? 'default' : 'pointer', opacity: exporting ? 0.6 : 1,
            }}
          >
            <Download size={12} /> {exporting ? 'Exportando…' : 'Baixar'}
          </button>
          {filter !== 'all' && (
            <span style={{ fontSize: 10.5, color: 'var(--dim)', flexBasis: '100%' }}>
              Só o tipo “{LOG_TYPE[filter]?.label ?? filter}” (segue o filtro selecionado acima).
            </span>
          )}
          {exportError && (
            <span style={{ fontSize: 10.5, color: 'var(--danger)', flexBasis: '100%' }}>{exportError}</span>
          )}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, padding: '0 18px 12px', flexWrap: 'wrap' }}>
        {['all', 'delivered', 'sent', 'deferred', 'rejected', 'other'].map(t => {
          const active = filter === t
          const cfg = LOG_TYPE[t]
          return (
            <button
              key={t} onClick={() => setFilter(t)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: 999,
                fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap',
                border: `1px solid ${active ? 'var(--sky)' : 'var(--border)'}`,
                background: active ? 'var(--accent-bg)' : 'var(--surface)',
                color: active ? 'var(--accent-fg)' : 'var(--muted)',
              }}
            >
              {cfg && <span style={{ width: 6, height: 6, borderRadius: '50%', background: cfg.dot }} />}
              {t === 'all' ? 'Todas' : cfg?.label ?? t}
              <span style={{ opacity: 0.6 }}>{counts[t] ?? 0}</span>
            </button>
          )
        })}
      </div>

      {error ? (
        <div style={{ padding: '16px 18px', fontSize: 12, color: 'var(--danger)' }}>{error}</div>
      ) : loading ? (
        <div style={{ padding: '24px 18px', fontSize: 12, color: 'var(--dim)', textAlign: 'center' }}>Carregando…</div>
      ) : visible.length === 0 ? (
        <div style={{ padding: '24px 18px', fontSize: 12, color: 'var(--dim)', textAlign: 'center' }}>
          Nenhuma linha corresponde ao filtro.
        </div>
      ) : (
        <div style={{ maxHeight: 420, overflowY: 'auto', borderTop: '1px solid var(--border)' }}>
          {visible.map((e, i) => {
            const cfg = LOG_TYPE[e.type] ?? LOG_TYPE.other
            return (
              <div
                key={i}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8, padding: '4px 14px',
                  borderBottom: '1px solid var(--surface)',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, lineHeight: 1.6, wordBreak: 'break-all',
                }}
                onMouseEnter={ev => { ev.currentTarget.style.background = 'var(--surface)' }}
                onMouseLeave={ev => { ev.currentTarget.style.background = 'transparent' }}
              >
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: cfg.dot, flexShrink: 0, marginTop: 5 }} />
                <span style={{ color: cfg.color, flex: 1 }}>{e.raw}</span>
                <button
                  onClick={() => copy(e.raw, i)}
                  title="Copiar linha"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied === i ? 'var(--ok)' : 'var(--dim)', flexShrink: 0, padding: 2 }}
                >
                  <Copy size={11} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function MetricasPage() {
  const { activeServer, isFleet, servers, setActiveServer } = useServer()
  const [periodKey, setPeriodKey]   = useState('24h')
  const [rows, setRows]             = useState([])
  const [snap, setSnap]             = useState(null)
  const [loading, setLoading]       = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const ambiguous = !activeServer && isFleet && servers.length > 1
  const hours = PERIODS.find(p => p.key === periodKey).hours
  const scopedId = activeServer?.id ?? (servers.length === 1 ? servers[0]?.id : null)

  // serverId null é válido aqui: com um servidor só cadastrado (frota
  // de 1), o backend resolve sozinho (_resolve_server_id) — só recusa
  // quando é genuinamente ambíguo, e nesse caso `ambiguous` já barrou
  // acima antes deste efeito rodar.
  const load = useCallback((opts = {}) => {
    if (ambiguous) { setLoading(false); return }
    opts.manual ? setRefreshing(true) : setLoading(true)
    const sid = activeServer?.id ?? null
    Promise.allSettled([
      fetchHistory(hours, 'quick', sid),
      fetchFullStatus(sid),
    ]).then(([h, s]) => {
      setRows(h.status === 'fulfilled' ? h.value : [])
      setSnap(s.status === 'fulfilled' ? s.value : null)
    }).finally(() => { setLoading(false); setRefreshing(false) })
  }, [activeServer, hours, ambiguous])

  useEffect(() => { load() }, [load])

  const { queuePts, funnelPts, sendPts, kpis } = useMemo(() => {
    if (rows.length === 0) return { queuePts: [], funnelPts: [], sendPts: [], kpis: null }
    const queuePts = rows.map(r => ({ time: fmtTimeShort(r.timestamp, hours), Fila: r.queue_total }))
    const funnelPts = rows.map(r => ({
      time: fmtTimeShort(r.timestamp, hours),
      Entregue: r.delivered ?? 0, Adiado: r.deferred ?? 0,
      Rejeitado: r.rejected ?? 0, 'Erro DNS': r.dns_errors ?? 0,
    }))
    const sendPts = rows.map(r => ({ time: fmtTimeShort(r.timestamp, hours), Enviadas: r.recent_sends ?? 0 }))

    const peak = rows.reduce((m, r) => (r.queue_total > m.queue_total ? r : m), rows[0])
    const delivRates = rows.map(r => {
      const total = (r.delivered ?? 0) + (r.rejected ?? 0) + (r.deferred ?? 0)
      return total > 0 ? (r.delivered / total) * 100 : null
    }).filter(v => v != null)
    const avgRate = delivRates.length ? delivRates.reduce((a, b) => a + b, 0) / delivRates.length : null
    const avgQueue = rows.reduce((s, r) => s + r.queue_total, 0) / rows.length
    const critEvents = rows.filter(r => CRIT_SEVERITIES.has(r.severity)).length
    const totalSent = rows.reduce((s, r) => s + (r.recent_sends ?? 0), 0)
    const totalDeferred = rows.reduce((s, r) => s + (r.deferred ?? 0), 0)
    const totalRejected = rows.reduce((s, r) => s + (r.rejected ?? 0), 0)
    return {
      queuePts, funnelPts, sendPts,
      kpis: {
        peak: peak.queue_total, peakAt: fmtTimeShort(peak.timestamp, hours),
        avgRate, avgQueue, critEvents, totalSent, totalDeferred, totalRejected,
      },
    }
  }, [rows, hours])

  const offenders = useMemo(() => {
    if (!snap) return null
    const list = (arr) => (Array.isArray(arr) ? arr : []).map(x =>
      typeof x === 'string' ? { label: x } : { label: x.domain ?? x.name ?? x.ip ?? JSON.stringify(x), count: x.count ?? x.n }
    )
    return {
      sender: snap.top_sender ? [{ label: snap.top_sender, count: snap.top_sender_count }] : [],
      recipient: snap.top_recipient ? [{ label: snap.top_recipient, count: snap.top_recipient_count }] : [],
      dest: snap.top_dest_domain ? [{ label: snap.top_dest_domain, count: snap.top_dest_domain_count }] : [],
      auth: snap.top_auth_user ? [{ label: snap.top_auth_user, count: snap.top_auth_count }] : [],
      defer: list(snap.top_defer_domains),
      rejected: list(snap.top_rejected_domains),
      authIps: list(snap.auth_ip_diversity),
    }
  }, [snap])

  if (ambiguous) return <ChooseServer servers={servers} onPick={setActiveServer} />

  const scopeLabel = activeServer?.name ?? (servers[0]?.name ?? 'servidor')

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '20px 24px 32px', width: '100%', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text)' }}>
            Métricas · {scopeLabel}
          </h2>
          <p style={{ margin: '5px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            {rows.length} ponto{rows.length === 1 ? '' : 's'} de dados · coleta a cada 30s
          </p>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ display: 'flex', gap: 4, background: 'var(--surface-alt)', borderRadius: 9, padding: 3, border: '1px solid var(--border)' }}>
            {PERIODS.map(p => (
              <button
                key={p.key} onClick={() => setPeriodKey(p.key)}
                style={{
                  padding: '5px 13px', borderRadius: 6, fontSize: 12.5, fontWeight: periodKey === p.key ? 600 : 500,
                  background: periodKey === p.key ? 'var(--card)' : 'transparent',
                  color: periodKey === p.key ? 'var(--sky)' : 'var(--muted)',
                  border: 'none', cursor: 'pointer',
                  boxShadow: periodKey === p.key ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                }}
              >
                {p.key}
              </button>
            ))}
          </div>
          <button
            onClick={() => load({ manual: true })} disabled={refreshing}
            title="Forçar atualização agora"
            style={{
              width: 30, height: 30, borderRadius: 8, background: 'var(--surface-alt)', border: 'none',
              display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)',
              cursor: refreshing ? 'not-allowed' : 'pointer', flexShrink: 0,
            }}
          >
            <RefreshCw size={13} style={{ animation: refreshing ? 'spin 1s linear infinite' : undefined }} />
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--dim)', fontSize: 13 }}>Carregando…</div>
      ) : (
        <>
          {rows.length === 0 ? (
            <p style={{ fontSize: 12, color: 'var(--dim)', textAlign: 'center', padding: '24px 0', fontStyle: 'italic' }}>
              Sem série temporal neste período — aguarde alguns ciclos de coleta.
            </p>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14 }} className="metricas-kpi">
                <Kpi label="Pico da fila" value={kpis.peak.toLocaleString('pt-BR')} sub={`às ${kpis.peakAt}`} color="var(--danger)" />
                <Kpi label="Entrega média" value={kpis.avgRate != null ? `${kpis.avgRate.toFixed(1).replace('.', ',')}%` : '—'} sub="meta 99%" color={kpis.avgRate != null && kpis.avgRate < 99 ? 'var(--warn)' : 'var(--ok)'} />
                <Kpi label="Enviadas no período" value={kpis.totalSent.toLocaleString('pt-BR')} sub={`${kpis.totalDeferred.toLocaleString('pt-BR')} adiadas · ${kpis.totalRejected.toLocaleString('pt-BR')} rejeitadas`} />
                <Kpi label="Fila média" value={Math.round(kpis.avgQueue).toLocaleString('pt-BR')} sub={`${kpis.critEvents} eventos críticos`} />
              </div>

              <ChartCard title="Volume da fila" sub={`mensagens acumuladas · ${periodKey}`} badge={`pico: ${kpis.peak.toLocaleString('pt-BR')}`}>
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={queuePts} margin={{ top: 4, right: 4, left: -14, bottom: 0 }}>
                    <defs>
                      <linearGradient id="metricasQueueFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--sky)" stopOpacity={0.25} />
                        <stop offset="100%" stopColor="var(--sky)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="time" tick={{ fontSize: 10.5, fill: 'var(--dim)' }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} minTickGap={40} />
                    <YAxis tick={{ fontSize: 10.5, fill: 'var(--dim)' }} axisLine={false} tickLine={false} width={40} />
                    <Tooltip {...chartTooltip} />
                    <Area type="monotone" dataKey="Fila" stroke="var(--sky)" strokeWidth={2} fill="url(#metricasQueueFill)" />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartCard>

              <ChartCard
                title="Funil de entrega"
                sub={`para onde o e-mail foi, por ciclo · ${periodKey}`}
                legend={FUNNEL_SERIES}
              >
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={funnelPts} margin={{ top: 4, right: 4, left: -14, bottom: 0 }} stackOffset="none">
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="time" tick={{ fontSize: 10.5, fill: 'var(--dim)' }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} minTickGap={40} />
                    <YAxis tick={{ fontSize: 10.5, fill: 'var(--dim)' }} axisLine={false} tickLine={false} width={40} />
                    <Tooltip {...chartTooltip} />
                    {FUNNEL_SERIES.map(s => (
                      <Area key={s.key} type="monotone" dataKey={s.key} stackId="funnel"
                            stroke={s.color} strokeWidth={1.5} fill={s.color} fillOpacity={0.18} />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
                {kpis.avgRate == null && (
                  <p style={{ fontSize: 11, color: 'var(--dim)', margin: '4px 0 8px', lineHeight: 1.5 }}>
                    Sem contagens de entrega neste período — o diag-exim.sh não conseguiu
                    ler o mainlog em nenhum ciclo (fila continua sendo lida). O funil volta
                    a preencher assim que o parser do log voltar.
                  </p>
                )}
              </ChartCard>

              <ChartCard title="Throughput de envio" sub={`mensagens processadas por ciclo · ${periodKey}`}>
                <ResponsiveContainer width="100%" height={160}>
                  <AreaChart data={sendPts} margin={{ top: 4, right: 4, left: -14, bottom: 0 }}>
                    <defs>
                      <linearGradient id="metricasSendFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--ok)" stopOpacity={0.22} />
                        <stop offset="100%" stopColor="var(--ok)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="time" tick={{ fontSize: 10.5, fill: 'var(--dim)' }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} minTickGap={40} />
                    <YAxis tick={{ fontSize: 10.5, fill: 'var(--dim)' }} axisLine={false} tickLine={false} width={40} />
                    <Tooltip {...chartTooltip} />
                    <Area type="monotone" dataKey="Enviadas" stroke="var(--ok)" strokeWidth={2} fill="url(#metricasSendFill)" />
                  </AreaChart>
                </ResponsiveContainer>
              </ChartCard>
            </>
          )}

          {/* ── Top ofensores do momento (snapshot completo) ── */}
          {offenders && (
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', margin: '4px 0 10px' }}>
                Top ofensores agora
                {snap?.timestamp && <span style={{ fontWeight: 400, color: 'var(--dim)', fontSize: 11.5 }}> · leitura de {fmtTimeShort(snap.timestamp, 24)}</span>}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
                <OffenderTable title="Maior remetente" rows={offenders.sender} empty="Nenhum remetente dominante." />
                <OffenderTable title="Maior destino (domínio)" rows={offenders.dest} empty="Nenhum destino dominante." />
                <OffenderTable title="Maior destinatário" rows={offenders.recipient} empty="Nenhum destinatário dominante." />
                <OffenderTable title="Domínios que mais adiam" rows={offenders.defer} empty="Nenhum adiamento concentrado." />
                <OffenderTable title="Domínios que mais rejeitam" rows={offenders.rejected} empty="Nenhuma rejeição concentrada." />
                <OffenderTable title="Conta de auth mais ativa" rows={offenders.auth} empty="Sem autenticação relevante." />
                {offenders.authIps.length > 0 && (
                  <OffenderTable title="Diversidade de IPs de auth" rows={offenders.authIps} />
                )}
              </div>
            </div>
          )}

          {/* ── Recursos do Exim (recolhido) ── */}
          {snap && <EximResources snap={snap} />}

          {/* ── Log Viewer embutido ── */}
          <InlineLogViewer serverId={scopedId} />
        </>
      )}

      <style>{`@media (max-width: 900px) { .metricas-kpi { grid-template-columns: repeat(2,1fr) !important; } }`}</style>
    </div>
  )
}
