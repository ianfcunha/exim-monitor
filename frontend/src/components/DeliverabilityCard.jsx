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
      style={{ background: ok ? 'var(--ok)' : 'var(--danger)' }}
    />
  )
}

// fg é usado como PREENCHIMENTO sólido do círculo da nota (com texto
// branco em cima) — precisa de um tom que funcione com texto branco nos
// dois temas, então fica fixo (não var(--ok)/var(--warn)/var(--danger),
// que clareiam no escuro pra continuarem legíveis como TEXTO, e ficariam
// claros demais pra servir de fundo com texto branco).
const GRADE_COLOR = {
  A: { bg: 'var(--ok-bg)', border: 'var(--ok-border)', fg: '#15803D' },
  B: { bg: 'var(--accent-bg)', border: 'var(--accent-border)', fg: '#9A3412' },
  C: { bg: 'var(--warn-bg)', border: 'var(--warn-border)', fg: '#B45309' },
  D: { bg: 'var(--warn-bg)', border: 'var(--warn-border)', fg: '#C2410C' },
  F: { bg: 'var(--danger-bg)', border: 'var(--danger-border)', fg: '#DC2626' },
}

function TrustScoreBadge({ trustScore }) {
  if (!trustScore) return null
  const c = GRADE_COLOR[trustScore.grade] || GRADE_COLOR.F
  const labels = { blocklist: 'Blocklist', spf: 'SPF', dkim: 'DKIM', dmarc: 'DMARC', cert: 'Certificado TLS' }
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14, borderRadius: 10,
      padding: '12px 16px', background: c.bg, border: `1px solid ${c.border}`,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 44, height: 44, borderRadius: 999, flexShrink: 0,
        background: c.fg, color: '#fff', fontSize: 20, fontWeight: 800,
      }}>
        {trustScore.grade}
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontSize: 15, fontWeight: 800, color: c.fg }}>{trustScore.score}/100</span>
          <span style={{ fontSize: 11, fontWeight: 600, color: c.fg }}>score de confiança do domínio</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
          {Object.entries(trustScore.breakdown || {}).map(([key, ok]) => (
            <span key={key} style={{
              fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 999,
              background: ok ? 'rgba(22,163,74,0.12)' : 'rgba(220,38,38,0.10)',
              color: ok ? 'var(--ok)' : 'var(--danger)',
            }}>
              {ok ? '✔' : '✖'} {labels[key] || key}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

function fmtCertDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function CertRow({ cert, ok }) {
  const days = cert?.days_remaining
  let text
  if (!cert?.valid) {
    text = 'certificado não encontrado'
  } else if (days < 0) {
    text = `expirado há ${Math.abs(days)} dia${Math.abs(days) !== 1 ? 's' : ''} (${fmtCertDate(cert.expires_at)})`
  } else {
    text = `expira em ${days} dia${days !== 1 ? 's' : ''} (${fmtCertDate(cert.expires_at)})`
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
      <StatusDot ok={!!ok} />
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', width: 52, flexShrink: 0 }}>TLS</span>
      <span style={{ fontSize: 11, color: ok ? 'var(--muted)' : 'var(--danger)' }}>{text}</span>
    </div>
  )
}

function AuthRow({ label, found, record }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
      <StatusDot ok={!!found} />
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', width: 52, flexShrink: 0 }}>{label}</span>
      {found && record ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
              {record}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-[320px] whitespace-normal break-all">{record}</TooltipContent>
        </Tooltip>
      ) : (
        <span style={{ fontSize: 11, color: found ? 'var(--ok)' : 'var(--danger)' }}>
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
            border: '1px solid var(--border)', padding: '6px 10px', fontSize: 12,
            color: 'var(--text)', outline: 'none', background: 'var(--surface)',
            transition: 'border-color 0.15s, box-shadow 0.15s',
          }}
          onFocus={e => { e.target.style.borderColor = 'var(--sky)'; e.target.style.boxShadow = '0 0 0 3px rgba(228,87,46,0.15)' }}
          onBlur={e => { e.target.style.borderColor = 'var(--border)'; e.target.style.boxShadow = 'none' }}
        />
        <Button variant="outline" size="sm" onClick={check} disabled={loading}>
          <RefreshCw size={12} style={{ animation: loading ? 'spin 1s linear infinite' : undefined }} />
          {loading ? 'Checando…' : 'Checar'}
        </Button>
      </div>

      {error && (
        <div style={{ borderRadius: 8, padding: '8px 10px', fontSize: 11, background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', color: 'var(--danger)' }}>
          {error}
        </div>
      )}

      {result && !error && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <TrustScoreBadge trustScore={result.trust_score} />

          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
              Blocklists{result.ip ? ` — IP ${result.ip}` : ''}
            </div>
            {!result.ip ? (
              <div style={{ fontSize: 11, color: 'var(--danger)' }}>
                {result.ip_error || 'Não foi possível determinar o IP público.'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {(result.blocklists || []).map(bl => (
                  <span key={bl.list} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 999,
                    background: bl.listed ? 'var(--danger-bg)' : 'var(--ok-bg)',
                    color: bl.listed ? 'var(--danger)' : 'var(--ok)',
                    border: `1px solid ${bl.listed ? 'var(--danger-border)' : 'var(--ok-border)'}`,
                  }}>
                    <StatusDot ok={!bl.listed} />
                    {bl.list}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div>
            <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
              Autenticação{result.domain ? ` — ${result.domain}` : ''}
            </div>
            <AuthRow label="SPF"   found={result.spf?.found}   record={result.spf?.record} />
            <AuthRow label="DKIM"  found={result.dkim?.found}  record={result.dkim?.selector ? `seletor padrão: ${result.dkim.selector}` : ''} />
            <AuthRow label="DMARC" found={result.dmarc?.found} record={result.dmarc?.record} />
            <CertRow cert={result.cert} ok={result.trust_score?.breakdown?.cert ?? (result.cert?.valid && result.cert?.days_remaining >= 0)} />
          </div>
        </div>
      )}

      {!result && !error && !loading && (
        <p style={{ fontSize: 11, color: 'var(--dim)', margin: 0 }}>
          Verifica se o IP do servidor está em blocklists conhecidas e se SPF/DKIM/DMARC estão configurados.
        </p>
      )}
    </div>
  )
}
