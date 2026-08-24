/**
 * Frota — Sessão 6, handoff Mail IQ 2.0.
 *
 * Grid de todos os servidores com fila e status, filtro por severidade.
 * Não existia como tela — o mockup assume 12 servidores fixos com dados
 * de exemplo; aqui os cards vêm de dados reais:
 *   - estado (crítico/atenção/normal/não verificado) e o motivo, de
 *     health.py via /incidents/summary (mesma fonte da Triagem, T5 —
 *     nunca diverge do que a Triagem mostra para o mesmo servidor);
 *   - fila atual e recência da coleta, de /status/quick por servidor
 *     (fan-out — aceitável para o tamanho de frota deste produto, não
 *     há endpoint agregado pronto e criar um só para isto seria escopo
 *     maior do que a tela pede).
 */
import { LayoutGrid, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchIncidentsSummary, fetchQuickStatus } from '../api/client'
import { fmtAge } from '../components/incidents/incidentLabels'
import { useServer } from '../contexts/ServerContext'

const STATE_STYLE = {
  critico:      { label: 'CRÍTICO',       text: 'var(--danger)', bg: 'var(--danger-bg)', border: 'var(--danger-border)' },
  atencao:      { label: 'ATENÇÃO',       text: 'var(--warn)',   bg: 'var(--warn-bg)',   border: 'var(--warn-border)' },
  indeterminado:{ label: 'NÃO VERIFICADO', text: 'var(--dim)',    bg: 'var(--surface-alt)', border: 'var(--border)' },
  ok:           { label: 'NORMAL',        text: 'var(--ok)',     bg: 'var(--ok-bg)',     border: 'var(--ok-border)' },
}
const FILTERS = [
  { key: 'todos', label: 'Todos' },
  { key: 'critico', label: 'Crítico' },
  { key: 'atencao', label: 'Atenção' },
  { key: 'indeterminado', label: 'Não verificado' },
  { key: 'ok', label: 'Normal' },
]

function ServerCard({ server, health, quick, onOpen }) {
  const state = health?.state ?? 'indeterminado'
  const st = STATE_STYLE[state] ?? STATE_STYLE.indeterminado
  const queue = quick?.queue?.total
  const collectedAgo = quick ? fmtAge(quick.timestamp) : null

  return (
    <button
      onClick={onOpen}
      style={{
        width: 'calc(25% - 11px)', minWidth: 240, textAlign: 'left', cursor: 'pointer',
        background: 'var(--card)', border: `${state === 'ok' || state === 'indeterminado' ? 1 : 1.5}px solid ${st.border}`,
        borderRadius: 12, padding: 18, display: 'flex', flexDirection: 'column', gap: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{
          width: 9, height: 9, borderRadius: '50%', background: st.text, flexShrink: 0, marginTop: 4,
          animation: state === 'critico' ? 'pulse-sky 1.4s ease-in-out infinite' : undefined, display: 'block',
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {server.name}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {server.host}
          </div>
        </div>
        <span style={{
          fontSize: 10, fontWeight: 700, color: st.text, background: st.bg, border: `1px solid ${st.border}`,
          borderRadius: 6, padding: '3px 7px', flexShrink: 0, letterSpacing: '0.03em', whiteSpace: 'nowrap',
        }}>
          {st.label}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div>
          <div style={{ fontSize: 10.5, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3, fontWeight: 600 }}>Fila</div>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 19, fontWeight: 700, color: queue > 0 ? st.text : 'var(--text)' }}>
            {queue != null ? queue.toLocaleString('pt-BR') : '—'}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10.5, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3, fontWeight: 600 }}>Coleta</div>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
            {collectedAgo ?? (server.ssh_status !== 'ok' ? server.ssh_status : '—')}
          </div>
        </div>
      </div>

      {health?.headline && state !== 'ok' && (
        <div style={{ fontSize: 11.5, color: st.text, background: st.bg, borderRadius: 7, padding: '9px 12px', lineHeight: 1.4 }}>
          {health.headline}
        </div>
      )}
    </button>
  )
}

export default function FrotaPage() {
  const navigate = useNavigate()
  const { servers } = useServer()
  const [healthByServer, setHealthByServer] = useState({})
  const [quickByServer, setQuickByServer]   = useState({})
  const [filter, setFilter] = useState('todos')
  const [loading, setLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState(null)

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([
      fetchIncidentsSummary(null).catch(() => null),
      Promise.all(servers.map(s =>
        fetchQuickStatus(s.id).then(q => [s.id, q]).catch(() => [s.id, null])
      )),
    ]).then(([summary, quickPairs]) => {
      const hMap = {}
      for (const h of summary?.servers ?? []) hMap[h.server_id] = h
      setHealthByServer(hMap)
      setQuickByServer(Object.fromEntries(quickPairs))
      setUpdatedAt(new Date())
    }).finally(() => setLoading(false))
  }, [servers])

  useEffect(() => { if (servers.length) load() }, [servers, load]) // eslint-disable-line

  useEffect(() => {
    if (!servers.length) return
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [servers, load])

  const counts = { todos: servers.length, critico: 0, atencao: 0, indeterminado: 0, ok: 0 }
  for (const s of servers) {
    const st = healthByServer[s.id]?.state ?? 'indeterminado'
    counts[st] = (counts[st] ?? 0) + 1
  }

  const visible = servers.filter(s => filter === 'todos' || (healthByServer[s.id]?.state ?? 'indeterminado') === filter)

  // Navega direto pra URL com o servidor no escopo — sem passar por
  // setActiveServer() pra não empilhar duas entradas de histórico numa
  // ação só (ver a nota de "voltar" em ServerContext.jsx).
  const onOpen = (server) => {
    navigate(`/triage?server=${server.id}`)
  }

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '20px 24px 32px', width: '100%', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text)' }}>
            Frota de servidores
          </h2>
          <p style={{ margin: '5px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            {servers.length} servidor{servers.length === 1 ? '' : 'es'}
            {updatedAt && ` · atualizado há ${fmtAge(updatedAt.toISOString())}`}
          </p>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {FILTERS.map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              style={{
                padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                background: filter === f.key ? 'var(--accent-bg)' : 'transparent',
                color: filter === f.key ? 'var(--accent-fg)' : 'var(--muted)',
                border: `1.5px solid ${filter === f.key ? 'var(--sky)' : 'var(--border)'}`,
                display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
              }}
            >
              {f.label}
              <span style={{
                fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 700,
                background: 'var(--surface-alt)', color: 'var(--muted)', padding: '1px 6px', borderRadius: 4,
              }}>
                {counts[f.key] ?? 0}
              </span>
            </button>
          ))}
          <button onClick={load} disabled={loading} style={{
            width: 30, height: 30, borderRadius: 8, background: 'var(--surface-alt)', border: 'none',
            display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', cursor: 'pointer',
          }}>
            <RefreshCw size={13} style={{ animation: loading ? 'spin 1s linear infinite' : undefined }} />
          </button>
        </div>
      </div>

      {servers.length === 0 ? (
        <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--dim)' }}>
          <LayoutGrid size={22} style={{ marginBottom: 8 }} />
          <p style={{ fontSize: 13 }}>Nenhum servidor cadastrado ainda.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
          {visible.map(s => (
            <ServerCard
              key={s.id} server={s} health={healthByServer[s.id]} quick={quickByServer[s.id]}
              onOpen={() => onOpen(s)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
