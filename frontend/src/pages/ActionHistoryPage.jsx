/**
 * ActionHistoryPage — histórico de ações executadas (auditoria).
 * Consome GET /api/actions/history — fonte central de auditoria sem
 * precisar SSH de volta no servidor pra ler actions.log em texto.
 * Apenas admins acessam esta página.
 */
import { ArrowLeft, CheckCircle, History, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { fetchActionHistory } from '../api/client'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useServer } from '../contexts/ServerContext'

const LIMIT_OPTIONS = [50, 100, 200, 500]

function fmt(iso) {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

export default function ActionHistoryPage({ onBack }) {
  const { servers } = useServer()
  const [rows, setRows]         = useState([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState(null)
  const [serverId, setServerId] = useState('all')
  const [limit, setLimit]       = useState(100)

  const serverName = (id) => servers.find(s => s.id === id)?.name ?? (id ? `#${id}` : '—')

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
    <div style={{ minHeight: '100vh', background: '#F1F5F9' }}>
      {/* Header */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 10,
        padding: '0 24px', background: '#fff',
        borderBottom: '1px solid #E2E8F0',
        boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
      }}>
        <div style={{ maxWidth: 1100, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 56, gap: 14, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <button onClick={onBack}
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#94A3B8', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              onMouseEnter={e => e.currentTarget.style.color = '#0EA5E9'}
              onMouseLeave={e => e.currentTarget.style.color = '#94A3B8'}
            >
              <ArrowLeft size={14} /> Dashboard
            </button>
            <span style={{ color: '#E2E8F0' }}>|</span>
            <span style={{ fontSize: 10, letterSpacing: '0.28em', textTransform: 'uppercase', color: '#0EA5E9', fontWeight: 700 }}>
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
                  style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid #E2E8F0', background: '#F8FAFC', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748B' }}>
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
          <div style={{ padding: '10px 14px', borderRadius: 10, background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B', fontSize: 12 }}>
            {error}
          </div>
        )}

        <div style={{
          background: '#fff', border: '1px solid #E2E8F0', borderRadius: 12,
          boxShadow: '0 1px 3px rgba(0,0,0,0.05)', overflow: 'hidden',
        }}>
          <div style={{
            padding: '12px 20px', borderBottom: '1px solid #F1F5F9',
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <History size={13} color="#94A3B8" />
            <span style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600 }}>
              {loading ? '…' : `${rows.length} ${rows.length === 1 ? 'ação' : 'ações'}`}
            </span>
          </div>

          {loading ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>
              Carregando…
            </div>
          ) : rows.length === 0 ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>
              Nenhuma ação registrada ainda.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: '#F8FAFC', borderBottom: '1px solid #E2E8F0' }}>
                    <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#94A3B8', whiteSpace: 'nowrap' }}>Quando</th>
                    <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#94A3B8', whiteSpace: 'nowrap' }}>Ator</th>
                    <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#94A3B8', whiteSpace: 'nowrap' }}>Ação</th>
                    <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#94A3B8' }}>Parâmetro</th>
                    <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#94A3B8', whiteSpace: 'nowrap' }}>Servidor</th>
                    <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#94A3B8', whiteSpace: 'nowrap' }}>Resultado</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} style={{ borderBottom: '1px solid #F1F5F9' }}>
                      <td style={{ padding: '9px 12px', color: '#64748B', whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: 11 }}>
                        {fmt(r.executed_at)}
                      </td>
                      <td style={{ padding: '9px 12px', color: '#0F172A', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        {r.actor}
                      </td>
                      <td style={{ padding: '9px 12px', color: '#0F172A', whiteSpace: 'nowrap' }}>
                        {r.action}
                      </td>
                      <td style={{ padding: '9px 12px', color: '#64748B', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.param ?? ''}>
                        {r.param ?? '—'}
                      </td>
                      <td style={{ padding: '9px 12px', color: '#64748B', whiteSpace: 'nowrap' }}>
                        {serverName(r.server_id)}
                      </td>
                      <td style={{ padding: '9px 12px', whiteSpace: 'nowrap' }}>
                        {r.success ? (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#F0FDF4', color: '#15803D', border: '1px solid #BBF7D0' }}>
                            <CheckCircle size={10} /> Sucesso
                          </span>
                        ) : (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: '#FEF2F2', color: '#991B1B', border: '1px solid #FECACA' }}>
                            <XCircle size={10} /> Falha
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {rows.length > 0 && (
          <p style={{ fontSize: 11, color: '#CBD5E1', margin: 0 }}>
            Passe o mouse sobre o parâmetro pra ver o valor completo quando truncado.
          </p>
        )}
      </div>
    </div>
  )
}
