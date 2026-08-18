/**
 * MessagesDrawer — painel lateral com detalhes de mensagens.
 * Abre ao clicar em qualquer MetricCard do dashboard.
 * Suporte a copy-to-clipboard em cada linha.
 */
import { AlertCircle, Check, Clock, Copy, Inbox, Mail, MailOpen, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { fetchLogMessages, fetchQueueMessages } from '../api/client'

// ── Configuração por tipo ────────────────────────────────────────────────────
const CONFIG = {
  queue: {
    title: 'Fila de Mensagens', icon: Inbox, endpoint: 'queue',
    columns: [
      { key: 'age',        label: 'Idade',        width: 60  },
      { key: 'size',       label: 'Tamanho',      width: 75  },
      { key: 'sender',     label: 'Remetente',    flex: true },
      { key: 'recipients', label: 'Destinatário', flex: true },
      { key: 'frozen',     label: 'Status',       width: 80  },
    ],
  },
  delivered: {
    title: 'Mensagens Entregues', icon: Mail, endpoint: 'log', logType: 'delivered',
    columns: [
      { key: 'timestamp', label: 'Horário',      width: 140 },
      { key: 'sender',    label: 'Remetente',    flex: true },
      { key: 'recipient', label: 'Destinatário', flex: true },
      { key: 'detail',    label: 'Host',         width: 160 },
    ],
  },
  rejected: {
    title: 'Mensagens Rejeitadas', icon: AlertCircle, endpoint: 'log', logType: 'rejected',
    columns: [
      { key: 'timestamp', label: 'Horário',      width: 140 },
      { key: 'sender',    label: 'Remetente',    flex: true },
      { key: 'recipient', label: 'Destinatário', flex: true },
      { key: 'detail',    label: 'Motivo',       width: 200 },
    ],
  },
  deferred: {
    title: 'Mensagens Deferidas', icon: Clock, endpoint: 'log', logType: 'deferred',
    columns: [
      { key: 'timestamp', label: 'Horário',      width: 140 },
      { key: 'sender',    label: 'Remetente',    flex: true },
      { key: 'recipient', label: 'Destinatário', flex: true },
      { key: 'detail',    label: 'Motivo',       width: 200 },
    ],
  },
  sent: {
    title: 'Recebidos pelo EXIM', icon: MailOpen, endpoint: 'log', logType: 'sent',
    columns: [
      { key: 'timestamp', label: 'Horário',      width: 140 },
      { key: 'sender',    label: 'Remetente',    flex: true },
      { key: 'recipient', label: 'Destinatário', flex: true },
      { key: 'detail',    label: 'Tamanho',      width: 80  },
    ],
  },
}

const LIMIT_OPTIONS = [50, 100, 200, 500]

// ── Botão copy inline ────────────────────────────────────────────────────────
function CopyRowBtn({ row }) {
  const [copied, setCopied] = useState(false)

  const text = Object.values(row)
    .map(v => (Array.isArray(v) ? v.join(', ') : String(v ?? '')))
    .filter(Boolean)
    .join(' | ')

  const copy = (e) => {
    e.stopPropagation()
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={copy}
          style={{
            width: 24, height: 24, borderRadius: 5,
            border: 'none',
            background: copied ? 'rgba(22,163,74,0.12)' : 'rgba(0,0,0,0.04)',
            cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background 0.15s', flexShrink: 0,
          }}
        >
          {copied
            ? <Check size={12} color="#16A34A" strokeWidth={2.5} />
            : <Copy size={12} color="#94A3B8" strokeWidth={2} />
          }
        </button>
      </TooltipTrigger>
      <TooltipContent>Copiar linha</TooltipContent>
    </Tooltip>
  )
}

// ── Célula ───────────────────────────────────────────────────────────────────
function CellValue({ col, row }) {
  const val = row[col.key]

  if (col.key === 'frozen') {
    return (
      <span style={{
        fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
        background: val ? '#FEF2F2' : '#F0FDF4',
        color: val ? '#991B1B' : '#15803D',
        border: `1px solid ${val ? '#FECACA' : '#BBF7D0'}`,
      }}>
        {val ? 'Frozen' : 'Normal'}
      </span>
    )
  }

  if (col.key === 'recipients' && Array.isArray(val)) {
    return (
      <span title={val.join(', ')}>
        {val[0] || '—'}
        {val.length > 1 && (
          <span style={{ fontSize: 10, color: '#94A3B8', marginLeft: 4 }}>+{val.length - 1}</span>
        )}
      </span>
    )
  }

  const str = String(val ?? '—')
  return <span title={str} style={{ color: str === '—' ? '#94A3B8' : undefined }}>{str || '—'}</span>
}

// ── Componente principal ─────────────────────────────────────────────────────
export default function MessagesDrawer({ cardType, onClose }) {
  const cfg      = CONFIG[cardType]
  const [data, setData]       = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const [limit, setLimit]     = useState(100)
  const [filter, setFilter]   = useState('')
  const [hovRow, setHovRow]   = useState(null)
  const abortRef = useRef(null)

  const load = useCallback(async (lim = limit) => {
    abortRef.current = null
    setLoading(true)
    setError(null)
    try {
      let result
      if (cfg.endpoint === 'queue') {
        result = await fetchQueueMessages()
      } else {
        result = await fetchLogMessages(cfg.logType, lim)
      }
      if (abortRef.current !== false) setData(result)
    } catch (e) {
      if (abortRef.current !== false)
        setError(e?.response?.data?.detail ?? 'Erro ao carregar mensagens.')
    } finally {
      if (abortRef.current !== false) setLoading(false)
    }
  }, [cfg, limit])

  useEffect(() => {
    abortRef.current = null
    load(limit)
    return () => { abortRef.current = false }
  }, [cardType, limit]) // eslint-disable-line

  const filtered = filter.trim()
    ? data.filter(row =>
        Object.values(row).some(v => String(v).toLowerCase().includes(filter.toLowerCase()))
      )
    : data

  const IconComp = cfg.icon

  return (
    <Sheet open onOpenChange={(v) => { if (!v) onClose() }}>
      <SheetContent aria-describedby={undefined} style={{ width: 'min(640px, 100vw)' }}>

        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #E2E8F0', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <div style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0, background: 'rgba(14,165,233,0.10)', border: '1px solid rgba(14,165,233,0.18)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <IconComp size={16} color="#0EA5E9" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <SheetTitle asChild>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>{cfg.title}</div>
            </SheetTitle>
            {!loading && !error && (
              <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 1 }}>
                {filtered.length} {filter ? `de ${data.length}` : ''} {data.length === 1 ? 'mensagem' : 'mensagens'}
              </div>
            )}
          </div>
          {cfg.endpoint === 'log' && (
            <Select value={String(limit)} onValueChange={v => setLimit(Number(v))}>
              <SelectTrigger className="h-[30px] py-0 text-[11px] text-muted">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LIMIT_OPTIONS.map(n => (
                  <SelectItem key={n} value={String(n)}>Últimas {n}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={() => load(limit)} disabled={loading}
                style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid #E2E8F0', background: '#F8FAFC', cursor: loading ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: loading ? 0.5 : 1, flexShrink: 0 }}>
                <RefreshCw size={13} color="#64748B" style={{ animation: loading ? 'spin 1s linear infinite' : undefined }} />
              </button>
            </TooltipTrigger>
            <TooltipContent>Atualizar</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={onClose}
                style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid #E2E8F0', background: '#F8FAFC', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <X size={14} color="#64748B" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Fechar (Esc)</TooltipContent>
          </Tooltip>
        </div>

        {/* Filtro */}
        <div style={{ padding: '10px 20px', borderBottom: '1px solid #F1F5F9', flexShrink: 0 }}>
          <input
            type="text" placeholder="Filtrar por endereço, host, motivo…"
            value={filter} onChange={e => setFilter(e.target.value)}
            style={{ width: '100%', borderRadius: 8, border: '1px solid #E2E8F0', background: '#F8FAFC', padding: '7px 12px', fontSize: 12, color: '#0F172A', outline: 'none', transition: 'border-color 0.15s', boxSizing: 'border-box' }}
            onFocus={e  => { e.target.style.borderColor = '#0EA5E9' }}
            onBlur={e   => { e.target.style.borderColor = '#E2E8F0' }}
          />
        </div>

        {/* Conteúdo */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {loading && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 12, color: '#94A3B8' }}>
              <RefreshCw size={22} style={{ animation: 'spin 1s linear infinite', color: '#0EA5E9' }} />
              <span style={{ fontSize: 12 }}>Buscando via SSH…</span>
            </div>
          )}
          {!loading && error && (
            <div style={{ padding: 20 }}>
              <div style={{ borderRadius: 10, padding: '12px 14px', fontSize: 12, background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B' }}>
                <strong>Erro:</strong> {error}
              </div>
            </div>
          )}
          {!loading && !error && filtered.length === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 8, color: '#94A3B8' }}>
              <IconComp size={28} strokeWidth={1.2} />
              <span style={{ fontSize: 12 }}>
                {filter ? 'Nenhum resultado para este filtro.' : 'Nenhuma mensagem encontrada.'}
              </span>
            </div>
          )}
          {!loading && !error && filtered.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#F8FAFC', borderBottom: '1px solid #E2E8F0', position: 'sticky', top: 0 }}>
                  {cfg.columns.map(col => (
                    <th key={col.key} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#94A3B8', width: col.flex ? undefined : col.width, whiteSpace: 'nowrap' }}>
                      {col.label}
                    </th>
                  ))}
                  {/* Coluna do botão copy */}
                  <th style={{ width: 32, padding: '8px 8px 8px 0' }} />
                </tr>
              </thead>
              <tbody>
                {filtered.map((row, i) => (
                  <tr
                    key={i}
                    onMouseEnter={() => setHovRow(i)}
                    onMouseLeave={() => setHovRow(null)}
                    style={{ borderBottom: '1px solid #F1F5F9', background: hovRow === i ? '#F8FAFC' : i % 2 === 0 ? '#fff' : '#FAFBFC', transition: 'background 0.1s' }}
                  >
                    {cfg.columns.map(col => (
                      <td key={col.key} style={{ padding: '9px 12px', maxWidth: col.flex ? 200 : col.width, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#0F172A' }}>
                        <CellValue col={col} row={row} />
                      </td>
                    ))}
                    <td style={{ padding: '0 8px 0 0', width: 32 }}>
                      {hovRow === i && <CopyRowBtn row={row} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer hint */}
        {!loading && !error && filtered.length > 0 && (
          <div style={{ padding: '6px 20px', borderTop: '1px solid #F1F5F9', fontSize: 10, color: '#CBD5E1', flexShrink: 0 }}>
            Passe o mouse em uma linha para copiar · <kbd style={{ fontFamily: 'monospace', background: '#F1F5F9', padding: '1px 5px', borderRadius: 4, border: '1px solid #E2E8F0' }}>ESC</kbd> fechar
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
