/**
 * DeliverabilityCard — checagem sob demanda de blocklist (DNSBL) e
 * SPF/DKIM/DMARC do servidor ativo.
 *
 * Chama a mesma API de ações (--action=check-deliverability, só
 * leitura no script remoto) — não faz polling, só quando pedido.
 */
import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { runAction } from '../api/client'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useServer } from '../contexts/ServerContext'

function StatusDot({ ok }) {
  return (
    <span
      className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
      style={{ background: ok ? '#16A34A' : '#DC2626' }}
    />
  )
}

function AuthRow({ label, found, record }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
      <StatusDot ok={!!found} />
      <span style={{ fontSize: 12, fontWeight: 600, color: '#0F172A', width: 52, flexShrink: 0 }}>{label}</span>
      {found && record ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span style={{ fontSize: 11, color: '#64748B', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
              {record}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-[320px] whitespace-normal break-all">{record}</TooltipContent>
        </Tooltip>
      ) : (
        <span style={{ fontSize: 11, color: found ? '#16A34A' : '#DC2626' }}>
          {found ? 'encontrado' : 'não encontrado'}
        </span>
      )}
    </div>
  )
}

export default function DeliverabilityCard() {
  const { activeServer }      = useServer()
  const [loading, setLoading] = useState(false)
  const [domain, setDomain]   = useState('')
  const [result, setResult]   = useState(null)
  const [error, setError]     = useState(null)

  const check = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await runAction('check-deliverability', domain.trim() || null, activeServer?.id ?? null)
      setResult(res)
    } catch (err) {
      setError(err?.response?.data?.detail || err.message || 'Erro ao checar deliverability.')
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="card space-y-3">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span className="section-label">Deliverability</span>
      </div>

      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text" value={domain} onChange={e => setDomain(e.target.value)}
          placeholder={result?.domain || 'domínio (opcional)'}
          onKeyDown={e => e.key === 'Enter' && !loading && check()}
          style={{
            flex: 1, minWidth: 0, boxSizing: 'border-box', borderRadius: 7,
            border: '1px solid #E2E8F0', padding: '6px 10px', fontSize: 12,
            color: '#0F172A', outline: 'none', background: '#F8FAFC',
          }}
        />
        <Button variant="outline" size="sm" onClick={check} disabled={loading}>
          <RefreshCw size={12} style={{ animation: loading ? 'spin 1s linear infinite' : undefined }} />
          {loading ? 'Checando…' : 'Checar'}
        </Button>
      </div>

      {error && (
        <div style={{ borderRadius: 8, padding: '8px 10px', fontSize: 11, background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B' }}>
          {error}
        </div>
      )}

      {result && !error && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
              Blocklists{result.ip ? ` — IP ${result.ip}` : ''}
            </div>
            {!result.ip ? (
              <div style={{ fontSize: 11, color: '#DC2626' }}>
                {result.ip_error || 'Não foi possível determinar o IP público.'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {(result.blocklists || []).map(bl => (
                  <span key={bl.list} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 999,
                    background: bl.listed ? '#FEF2F2' : '#F0FDF4',
                    color: bl.listed ? '#991B1B' : '#15803D',
                    border: `1px solid ${bl.listed ? '#FECACA' : '#BBF7D0'}`,
                  }}>
                    <StatusDot ok={!bl.listed} />
                    {bl.list}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
              Autenticação{result.domain ? ` — ${result.domain}` : ''}
            </div>
            <AuthRow label="SPF"   found={result.spf?.found}   record={result.spf?.record} />
            <AuthRow label="DKIM"  found={result.dkim?.found}  record={result.dkim?.selector ? `seletor padrão: ${result.dkim.selector}` : ''} />
            <AuthRow label="DMARC" found={result.dmarc?.found} record={result.dmarc?.record} />
          </div>
        </div>
      )}

      {!result && !error && !loading && (
        <p style={{ fontSize: 11, color: '#94A3B8', margin: 0 }}>
          Verifica se o IP do servidor está em blocklists conhecidas e se SPF/DKIM/DMARC estão configurados.
        </p>
      )}
    </div>
  )
}
