/**
 * LogViewerDrawer — visualizador de mainlog em tempo real.
 * Exibe as últimas N linhas com cores por tipo, filtros e auto-refresh.
 * Suporte a copy-to-clipboard em cada linha.
 */
import { Check, Copy, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { fetchLogTail } from '../api/client'

const TYPE_CONFIG = {
  delivered: { label: 'Entregues', color: '#16A34A', bg: 'rgba(22,163,74,0.08)',  dot: '#16A34A' },
  rejected:  { label: 'Rejeitados', color: '#DC2626', bg: 'rgba(220,38,38,0.08)', dot: '#DC2626' },
  deferred:  { label: 'Deferidos', color: '#D97706', bg: 'rgba(217,119,6,0.08)',  dot: '#D97706' },
  sent:      { label: 'Enviados', color: '#0EA5E9', bg: 'rgba(14,165,233,0.08)',  dot: '#0EA5E9' },
  other:     { label: 'Outros', color: '#64748B', bg: 'transparent',              dot: '#94A3B8' },
}

const LIMIT_OPTIONS = [100, 200, 300, 500]

/* ── Chip de filtro ── */
function TypeChip({ type, active, onClick }) {
  const cfg = TYPE_CONFIG[type]
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 5,
        padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 500,
        cursor: 'pointer',
        border: active ? `1px solid ${cfg.dot}` : '1px solid #E2E8F0',
        background: active ? cfg.bg : '#fff',
        color: active ? cfg.color : '#64748B',
        transition: 'all 0.15s', whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: active ? cfg.dot : '#CBD5E1', flexShrink: 0 }} />
      {cfg.label}
    </button>
  )
}

/* ── Botão de cópia inline ── */
function CopyBtn({ text }) {
  const [copied, setCopied] = useState(false)
  const copy = (e) => {
    e.stopPropagation()
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <button
      onClick={copy}
      title="Copiar linha"
      style={{
        flexShrink: 0, width: 20, height: 20,
        borderRadius: 4, border: 'none',
        background: copied ? 'rgba(22,163,74,0.12)' : 'rgba(0,0,0,0.05)',
        cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'background 0.15s',
        opacity: 0.7,
      }}
    >
      {copied
        ? <Check size={11} color="#16A34A" strokeWidth={2.5} />
        : <Copy size={11} color="#64748B" strokeWidth={2} />
      }
    </button>
  )
}

/* ── Linha do log ── */
function LogLine({ entry, highlight }) {
  const [hov, setHov] = useState(false)
  const cfg           = TYPE_CONFIG[entry.type] ?? TYPE_CONFIG.other
  const raw           = entry.raw ?? ''

  let content
  if (highlight && raw.toLowerCase().includes(highlight.toLowerCase())) {
    const idx = raw.toLowerCase().indexOf(highlight.toLowerCase())
    content = (
      <>
        {raw.slice(0, idx)}
        <mark style={{ background: '#FEF08A', color: '#713F12', borderRadius: 2, padding: '0 1px' }}>
          {raw.slice(idx, idx + highlight.length)}
        </mark>
        {raw.slice(idx + highlight.length)}
      </>
    )
  } else {
    content = raw
  }

  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 8,
        padding: '4px 12px',
        borderBottom: '1px solid #F1F5F9',
        background: hov ? '#F8FAFC' : cfg.bg,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11, lineHeight: 1.6, wordBreak: 'break-all',
        transition: 'background 0.1s',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: cfg.dot, flexShrink: 0, marginTop: 5 }} />
      <span style={{ color: cfg.color, flex: 1 }}>{content}</span>
      {hov && <CopyBtn text={raw} />}
    </div>
  )
}

/* ── Componente principal ── */
export default function LogViewerDrawer({ onClose }) {
  const [entries, setEntries]         = useState([])
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState(null)
  const [limit, setLimit]             = useState(300)
  const [filter, setFilter]           = useState('all')
  const [search, setSearch]           = useState('')
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [refreshing, setRefreshing]   = useState(false)
  const intervalRef = useRef(null)

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true)
    setError(null)
    try {
      const data = await fetchLogTail(limit)
      setEntries(data)
    } catch (e) {
      setError(e?.response?.data?.detail ?? e.message ?? 'Erro ao carregar log')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [limit])

  useEffect(() => { setLoading(true); load() }, [load])

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(() => load(), 30_000)
    }
    return () => clearInterval(intervalRef.current)
  }, [autoRefresh, load])

  const visible = entries.filter(e => {
    if (filter !== 'all' && e.type !== filter) return false
    if (search && !e.raw?.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const counts = {}
  entries.forEach(e => { counts[e.type] = (counts[e.type] ?? 0) + 1 })

  return (
    <Sheet open onOpenChange={(v) => { if (!v) onClose() }}>
      <SheetContent aria-describedby={undefined} style={{ width: 'min(780px, 100vw)' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid #E2E8F0', gap: 12, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: 8, background: '#F8FAFC', border: '1px solid #E2E8F0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span style={{ fontSize: 14 }}>📋</span>
            </div>
            <div>
              <SheetTitle asChild>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>Log Viewer</div>
              </SheetTitle>
              <div style={{ fontSize: 10, color: '#94A3B8', fontFamily: 'monospace' }}>
                mainlog · {visible.length}{(filter !== 'all' || search) ? ` de ${entries.length}` : ''} entradas
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              onClick={() => setAutoRefresh(v => !v)}
              title={autoRefresh ? 'Desativar auto-refresh' : 'Ativar auto-refresh (30s)'}
              style={{
                display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 7,
                fontSize: 11, fontWeight: 500, cursor: 'pointer',
                border: autoRefresh ? '1px solid #BAE6FD' : '1px solid #E2E8F0',
                background: autoRefresh ? '#F0F9FF' : '#fff',
                color: autoRefresh ? '#0369A1' : '#64748B', transition: 'all 0.15s',
              }}
            >
              <RefreshCw size={11} style={{ animation: refreshing ? 'spin 1s linear infinite' : undefined }} />
              {autoRefresh ? '30s' : 'Auto'}
            </button>
            <button onClick={() => load(true)} disabled={refreshing} title="Atualizar agora"
              style={{ width: 30, height: 30, borderRadius: 7, border: '1px solid #E2E8F0', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#64748B', opacity: refreshing ? 0.5 : 1 }}>
              <RefreshCw size={13} style={{ animation: refreshing ? 'spin 1s linear infinite' : undefined }} />
            </button>
            <Select value={String(limit)} onValueChange={v => setLimit(Number(v))}>
              <SelectTrigger className="h-[26px] py-0 text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIMIT_OPTIONS.map(l => (
                  <SelectItem key={l} value={String(l)}>{l} linhas</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button onClick={onClose} style={{ width: 30, height: 30, borderRadius: 7, border: '1px solid #E2E8F0', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#64748B' }}>
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Filtros */}
        <div style={{ padding: '10px 16px', borderBottom: '1px solid #F1F5F9', display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <button onClick={() => setFilter('all')} style={{
              display: 'flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: 999,
              fontSize: 11, fontWeight: 500, cursor: 'pointer', whiteSpace: 'nowrap',
              border: filter === 'all' ? '1px solid #0EA5E9' : '1px solid #E2E8F0',
              background: filter === 'all' ? 'rgba(14,165,233,0.08)' : '#fff',
              color: filter === 'all' ? '#0369A1' : '#64748B', transition: 'all 0.15s',
            }}>
              Todos
              <span style={{ fontSize: 10, padding: '0 5px', borderRadius: 999, background: filter === 'all' ? '#0EA5E9' : '#E2E8F0', color: filter === 'all' ? '#fff' : '#64748B' }}>
                {entries.length}
              </span>
            </button>
            {Object.keys(TYPE_CONFIG).filter(t => t !== 'other').map(type => (
              <TypeChip key={type} type={type} active={filter === type} onClick={() => setFilter(f => f === type ? 'all' : type)} />
            ))}
            {counts.other > 0 && (
              <TypeChip type="other" active={filter === 'other'} onClick={() => setFilter(f => f === 'other' ? 'all' : 'other')} />
            )}
          </div>
          <input
            type="text" placeholder="Filtrar por texto…" value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: '100%', padding: '6px 10px', borderRadius: 7, fontSize: 12, border: '1px solid #E2E8F0', outline: 'none', color: '#0F172A', background: '#F8FAFC', boxSizing: 'border-box' }}
          />
        </div>

        {/* Corpo */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 160, gap: 10, color: '#94A3B8', fontSize: 13 }}>
              <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite' }} />Carregando log…
            </div>
          ) : error ? (
            <div style={{ margin: 16, padding: '12px 14px', borderRadius: 10, background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B', fontSize: 12 }}>
              <strong>Erro:</strong> {error}
            </div>
          ) : visible.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 160, color: '#94A3B8', fontSize: 13 }}>
              {search || filter !== 'all' ? 'Nenhuma entrada corresponde ao filtro.' : 'Log vazio.'}
            </div>
          ) : (
            visible.map((entry, i) => <LogLine key={i} entry={entry} highlight={search} />)
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '8px 16px', borderTop: '1px solid #F1F5F9', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10, color: '#94A3B8', flexShrink: 0 }}>
          <span>
            Passe o mouse em uma linha para copiar · <kbd style={{ fontFamily: 'monospace', background: '#F1F5F9', padding: '1px 5px', borderRadius: 4, border: '1px solid #E2E8F0' }}>ESC</kbd> fechar
          </span>
          <div style={{ display: 'flex', gap: 12 }}>
            {Object.entries(counts).filter(([, v]) => v > 0).map(([type, count]) => (
              <span key={type} style={{ color: TYPE_CONFIG[type]?.color ?? '#64748B' }}>
                {TYPE_CONFIG[type]?.label ?? type}: {count}
              </span>
            ))}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
