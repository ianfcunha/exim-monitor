/**
 * Sessão 3, Tarefa 4 — Reputação como vigilância contínua.
 *
 * A checagem em si (DNSBL, SPF/DKIM/DMARC, certificado TLS) já roda
 * sozinha a cada ciclo completo do coletor desde a Sessão 2 — não é
 * mais um botão. Esta tela é o que faltava: estado atual por servidor
 * e histórico de entrada/saída de cada blocklist, com data (derivado
 * do ciclo de vida dos incidentes `reputation`, não uma tabela nova —
 * ver backend/app/routers/reputation.py).
 */
import { AlertTriangle, ArrowLeft, CheckCircle2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchReputation } from '../api/client'
import { Button } from '@/components/ui/button'
import { useServer } from '../contexts/ServerContext'

const CHECK_LABELS = {
  blocklist: 'DNSBL (blocklist)', spf_dkim_dmarc: 'SPF / DKIM / DMARC', cert: 'Certificado TLS',
}

function fmtDateTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function CheckBadge({ label, check }) {
  const ok = check.status === 'ok'
  return (
    <div style={{
      flex: 1, minWidth: 160, padding: '10px 12px', borderRadius: 9,
      border: `1px solid ${ok ? 'var(--ok-border)' : 'var(--danger-border)'}`,
      background: ok ? 'var(--ok-bg)' : 'var(--danger-bg)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        {ok ? <CheckCircle2 size={13} color="var(--ok)" /> : <AlertTriangle size={13} color="var(--danger)" />}
        <span style={{ fontSize: 11.5, fontWeight: 700, color: ok ? 'var(--ok)' : 'var(--danger)' }}>{label}</span>
      </div>
      {ok ? (
        <p style={{ fontSize: 11, color: 'var(--muted)', margin: 0 }}>
          OK{check.since ? ` — desde ${fmtDateTime(check.since)}` : ''}
        </p>
      ) : (
        <>
          <p style={{ fontSize: 11, color: 'var(--danger)', margin: '0 0 3px' }}>Em risco desde {fmtDateTime(check.since)}</p>
          <p style={{ fontSize: 10.5, color: 'var(--muted)', margin: 0 }}>{check.description}</p>
        </>
      )}
    </div>
  )
}

function HistoryRow({ entry }) {
  const isEnter = entry.event === 'entrou'
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, padding: '5px 0', fontSize: 11.5 }}>
      <span style={{ width: 74, flexShrink: 0, color: 'var(--dim)' }}>{fmtDateTime(entry.at)}</span>
      <span style={{ color: isEnter ? 'var(--danger)' : 'var(--ok)', fontWeight: 600, width: 50, flexShrink: 0 }}>
        {isEnter ? 'entrou' : 'saiu'}
      </span>
      <span style={{ color: 'var(--muted)' }}>
        {CHECK_LABELS[entry.type] ?? entry.type} — {entry.entity}
      </span>
    </div>
  )
}

function ServerCard({ row }) {
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
      padding: 16, marginBottom: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)' }}>{row.server_name}</span>
        <span style={{ fontSize: 10.5, color: 'var(--dim)' }}>última checagem: {fmtDateTime(row.last_checked_at)}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {Object.entries(row.checks).map(([type, check]) => (
          <CheckBadge key={type} label={CHECK_LABELS[type] ?? type} check={check} />
        ))}
      </div>
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8 }}>
        <p style={{ fontSize: 10, fontWeight: 700, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
          Histórico
        </p>
        {row.history.length === 0 ? (
          <p style={{ fontSize: 11, color: 'var(--dim)' }}>Nenhuma entrada/saída registrada ainda.</p>
        ) : (
          row.history.map((entry, i) => <HistoryRow key={i} entry={entry} />)
        )}
      </div>
    </div>
  )
}

export default function ReputationPage() {
  const navigate = useNavigate()
  const { activeServer, isFleet } = useServer()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)

  // Sessão 5: esta tela chamava fetchReputation() sem argumento e
  // renderizava a frota inteira mesmo com um servidor selecionado no
  // seletor — era a única aba que ignorava o escopo global da URL.
  const scopeId = isFleet ? null : activeServer?.id ?? null

  const load = useCallback(() => {
    setLoading(true)
    fetchReputation(scopeId).then(setRows).catch(() => setRows([])).finally(() => setLoading(false))
  }, [scopeId])

  useEffect(() => { load() }, [load])

  return (
    <div style={{ minHeight: '100vh', background: 'var(--surface)' }}>
      <header style={{
        padding: '14px 24px', background: 'var(--card)', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={() => navigate('/triage')}
            style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--dim)', fontSize: 12, padding: 0 }}
          >
            <ArrowLeft size={14} /> Triagem
          </button>
          <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
          <h1 style={{ fontSize: 14, fontWeight: 800, color: 'var(--text)', margin: 0 }}>Reputação</h1>
        </div>
        <Button size="sm" variant="outline" onClick={load} disabled={loading}>
          <RefreshCw size={12} style={{ animation: loading ? 'spin 1s linear infinite' : undefined }} /> Atualizar
        </Button>
      </header>

      <div style={{ maxWidth: 900, margin: '0 auto', padding: 16 }}>
        {loading ? (
          <p style={{ fontSize: 12, color: 'var(--dim)' }}>Carregando…</p>
        ) : rows.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--dim)' }}>Nenhum servidor encontrado.</p>
        ) : (
          <>
            <p style={{ fontSize: 11, color: 'var(--dim)', margin: '0 0 10px' }}>
              {isFleet
                ? `Toda a frota — ${rows.length} servidor${rows.length === 1 ? '' : 'es'}.`
                : `Escopo: ${activeServer?.name ?? 'servidor selecionado'}.`}
            </p>
            {rows.map(row => <ServerCard key={row.server_id} row={row} />)}
          </>
        )}
      </div>
    </div>
  )
}
