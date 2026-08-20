/**
 * ActionHistoryPage — histórico de ações executadas (auditoria).
 * Consome GET /api/actions/history — fonte central de auditoria sem
 * precisar SSH de volta no servidor pra ler actions.log em texto.
 * Apenas admins acessam esta página.
 */
import { ArrowLeft, CheckCircle, ChevronDown, ChevronRight, History, XCircle } from 'lucide-react'
import { Fragment, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchActionHistory } from '../api/client'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useServer } from '../contexts/ServerContext'

const LIMIT_OPTIONS = [50, 100, 200, 500]
const SNAPSHOT_MARKER = '\n\n--- Estado antes da ação ---\n'

function fmt(iso) {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

// message = "<mensagem legível>" + SNAPSHOT_MARKER + "<JSON do before_snapshot>",
// anexados no backend (routers/actions.py) por não haver coluna própria
// pro snapshot — separa de volta pra exibir cada parte com seu próprio estilo.
function splitMessage(message) {
  if (!message) return { text: '', snapshot: null }
  const idx = message.indexOf(SNAPSHOT_MARKER)
  if (idx === -1) return { text: message, snapshot: null }
  return { text: message.slice(0, idx), snapshot: message.slice(idx + SNAPSHOT_MARKER.length) }
}

export default function ActionHistoryPage() {
  const navigate = useNavigate()
  const onBack = () => navigate('/dashboard')
  const { servers } = useServer()
  const [rows, setRows]         = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)
  const [serverId, setServerId] = useState('all')
  const [limit, setLimit]       = useState(100)
  const [expanded, setExpanded] = useState(() => new Set())

  const serverName = (id) => servers.find(s => s.id === id)?.name ?? (id ? `#${id}` : '—')

  const toggleExpanded = (id) => {
    setExpanded(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const load = () => {
    setLoading(true)
    setError(null)
    fetchActionHistory(serverId === 'all' ? null : Number(serverId), limit)
      .then(setRows)
      .catch(e => setError(e?.response?.data?.detail ?? e.message ?? 'Erro ao carregar histórico.'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [serverId, limit]) // eslint-disable-line

  return (
    <div style={{ minHeight: '100vh', background: 'var(--surface)' }}>
      {/* Header */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 10,
        padding: '0 24px', background: '#fff',
        borderBottom: '1px solid var(--border)',
        boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
      }}>
        <div style={{ maxWidth: 1100, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 56, gap: 14, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <button onClick={onBack}
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--dim)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--sky)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--dim)'}
            >
              <ArrowLeft size={14} /> Dashboard
            </button>
            <span style={{ color: 'var(--border)' }}>|</span>
            <span style={{ fontSize: 10, letterSpacing: '0.28em', textTransform: 'uppercase', color: 'var(--sky)', fontWeight: 700 }}>
              Histórico de Ações
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {servers.length > 1 && (
              <Select value={serverId} onValueChange={setServerId}>
                <SelectTrigger className="w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="all">Todos os servidores</SelectItem>
                  {servers.map(s => (
                    <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Select value={String(limit)} onValueChange={v => setLimit(Number(v))}>
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {LIMIT_OPTIONS.map(n => (
                  <SelectItem key={n} value={String(n)}>Últimas {n}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Tooltip>
              <TooltipTrigger asChild>
                <button onClick={load}
                  style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
                  <History size={13} style={{ animation: loading ? 'spin 1s linear infinite' : undefined }} />
                </button>
              </TooltipTrigger>
              <TooltipContent>Atualizar</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </header>

      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {error && (
          <div style={{ padding: '10px 14px', borderRadius: 10, background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', color: 'var(--danger)', fontSize: 12 }}>
            {error}
          </div>
        )}

        <div style={{
          background: '#fff', border: '1px solid var(--border)', borderRadius: 12,
          boxShadow: '0 1px 3px rgba(0,0,0,0.05)', overflow: 'hidden',
        }}>
          <div style={{
            padding: '12px 20px', borderBottom: '1px solid var(--surface)',
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <History size={13} color="var(--dim)" />
            <span style={{ fontSize: 11, color: 'var(--dim)', fontWeight: 600 }}>
              {loading ? '…' : `${rows.length} ${rows.length === 1 ? 'ação' : 'ações'}`}
            </span>
          </div>

          {loading ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--dim)', fontSize: 13 }}>
              Carregando…
            </div>
          ) : rows.length === 0 ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--dim)', fontSize: 13 }}>
              Nenhuma ação registrada ainda.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
                    <th style={{ padding: '8px 4px', width: 28 }} aria-hidden="true" />
                    <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--dim)', whiteSpace: 'nowrap' }}>Quando</th>
                    <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--dim)', whiteSpace: 'nowrap' }}>Ator</th>
                    <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--dim)', whiteSpace: 'nowrap' }}>Ação</th>
                    <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--dim)' }}>Parâmetro</th>
                    <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--dim)', whiteSpace: 'nowrap' }}>Servidor</th>
                    <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--dim)', whiteSpace: 'nowrap' }}>Resultado</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => {
                    const { text: msgText, snapshot } = splitMessage(r.message)
                    const hasDetails = !!(msgText || snapshot)
                    const isOpen = expanded.has(r.id)
                    return (
                      <Fragment key={r.id}>
                        <tr style={{ borderBottom: isOpen ? 'none' : '1px solid var(--surface)' }}>
                          <td style={{ padding: '9px 4px', textAlign: 'center' }}>
                            {hasDetails && (
                              <button
                                onClick={() => toggleExpanded(r.id)}
                                aria-expanded={isOpen}
                                aria-label={isOpen ? 'Ocultar detalhes' : 'Mostrar detalhes'}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--dim)', display: 'flex', padding: 2 }}
                              >
                                {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                              </button>
                            )}
                          </td>
                          <td style={{ padding: '9px 12px', color: 'var(--muted)', whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: 11 }}>
                            {fmt(r.executed_at)}
                          </td>
                          <td style={{ padding: '9px 12px', color: 'var(--text)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                            {r.actor}
                          </td>
                          <td style={{ padding: '9px 12px', color: 'var(--text)', whiteSpace: 'nowrap' }}>
                            {r.action}
                          </td>
                          <td style={{ padding: '9px 12px', color: 'var(--muted)', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.param ?? ''}>
                            {r.param ?? '—'}
                          </td>
                          <td style={{ padding: '9px 12px', color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                            {serverName(r.server_id)}
                          </td>
                          <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>
                            {r.success ? (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'var(--ok-bg)', color: 'var(--ok)', border: '1px solid var(--ok-border)' }}>
                                <CheckCircle size={10} /> Sucesso
                              </span>
                            ) : (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--danger-border)' }}>
                                <XCircle size={10} /> Falha
                              </span>
                            )}
                          </td>
                        </tr>
                        {isOpen && hasDetails && (
                          <tr style={{ borderBottom: '1px solid var(--surface)' }}>
                            <td />
                            <td colSpan={6} style={{ padding: '0 12px 12px' }}>
                              <div style={{ borderRadius: 8, background: 'var(--surface)', border: '1px solid var(--border)', padding: '10px 12px' }}>
                                {msgText && (
                                  <p style={{ margin: 0, fontSize: 12, color: '#334155', whiteSpace: 'pre-wrap' }}>{msgText}</p>
                                )}
                                {snapshot && (
                                  <div style={{ marginTop: msgText ? 8 : 0 }}>
                                    <p style={{ margin: '0 0 4px', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--dim)' }}>
                                      Estado antes da ação
                                    </p>
                                    <pre style={{
                                      margin: 0, fontSize: 11, fontFamily: 'monospace', color: 'var(--text)',
                                      background: '#fff', border: '1px solid var(--border)', borderRadius: 6,
                                      padding: '8px 10px', overflowX: 'auto', whiteSpace: 'pre',
                                    }}>{snapshot}</pre>
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {rows.length > 0 && (
          <p style={{ fontSize: 11, color: 'var(--border)', margin: 0 }}>
            Passe o mouse sobre o parâmetro pra ver o valor completo quando truncado.
          </p>
        )}
      </div>
    </div>
  )
}
