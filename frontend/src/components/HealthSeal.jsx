/**
 * HealthSeal — Sessão 4, Tarefa 5: o selo de saúde do servidor, com os
 * incidentes que o causaram.
 *
 * Este componente existe para que a Triagem e o painel clássico exibam
 * literalmente o mesmo elemento, alimentado pelo mesmo endpoint
 * (health.py no backend). Antes, o painel derivava o próprio selo do
 * campo `severity` do último snapshot de coleta e chegava a mostrar
 * "DIAGNÓSTICO ● OK" em verde no mesmo instante em que a Triagem dizia
 * "Entrega degradada — 2 incidentes ativos".
 *
 * Quando o estado é "indeterminado", o selo diz o que não foi possível
 * verificar e por quê — não vira verde por falta de notícia (T1).
 */
import { AlertTriangle, CheckCircle2, HelpCircle, ShieldAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { fetchServerHealth } from '../api/client'
import { useServer } from '../contexts/ServerContext'

export const STATE_STYLE = {
  critico:       { color: 'var(--danger)', Icon: ShieldAlert },
  atencao:       { color: 'var(--warn)',   Icon: AlertTriangle },
  indeterminado: { color: 'var(--dim)',    Icon: HelpCircle },
  ok:            { color: 'var(--ok)',     Icon: CheckCircle2 },
}

export default function HealthSeal({ health: provided, pollMs = 30_000 }) {
  const navigate = useNavigate()
  const { activeServer } = useServer()
  const [fetched, setFetched] = useState(null)

  useEffect(() => {
    if (provided || !activeServer) return
    let alive = true
    const load = () => fetchServerHealth(activeServer.id)
      .then(h => { if (alive) setFetched(h) })
      .catch(() => { if (alive) setFetched(null) })
    load()
    const id = setInterval(load, pollMs)
    return () => { alive = false; clearInterval(id) }
  }, [provided, activeServer, pollMs])

  const health = provided ?? fetched
  if (!health) return null

  const style = STATE_STYLE[health.state] ?? STATE_STYLE.indeterminado
  const { Icon } = style
  const unknown = health.unknown_checks ?? []
  const incidents = health.incidents ?? []

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="flex flex-shrink-0 items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-semibold outline-none focus-visible:ring-1 focus-visible:ring-primary"
          style={{
            border: `1px solid ${style.color}30`, background: `${style.color}12`, color: style.color,
          }}
        >
          <Icon size={13} />
          {health.headline}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" style={{ maxWidth: 360 }}>
        <div style={{ fontWeight: 700, color: 'var(--text)', marginBottom: 8, fontSize: 12 }}>
          {health.label}
        </div>

        {incidents.length > 0 && (
          <div style={{ marginBottom: unknown.length ? 10 : 0 }}>
            <div style={{ fontSize: 10.5, color: 'var(--dim)', marginBottom: 5 }}>
              Incidentes que causam este estado:
            </div>
            {incidents.map(i => (
              <button
                key={i.id}
                onClick={() => navigate(`/triage/${i.id}${window.location.search}`)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '5px 8px',
                  marginBottom: 3, borderRadius: 6, border: '1px solid var(--border)',
                  background: 'var(--surface)', cursor: 'pointer', fontSize: 11.5, color: 'var(--text)',
                }}
              >
                <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{i.display_id}</span>
                {' — '}{i.entity}
              </button>
            ))}
          </div>
        )}

        {unknown.length > 0 && (
          <div>
            <div style={{ fontSize: 10.5, color: 'var(--dim)', marginBottom: 5 }}>
              Não foi possível verificar:
            </div>
            {unknown.map(u => (
              <div key={u.key} style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 6, lineHeight: 1.45 }}>
                <strong style={{ color: 'var(--text)' }}>{u.label}</strong> — {u.reason}
              </div>
            ))}
          </div>
        )}

        {incidents.length === 0 && unknown.length === 0 && (
          <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
            Todas as verificações responderam e nenhuma encontrou problema.
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
