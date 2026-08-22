/**
 * Sessão 2, Tarefa 6 — Tela de Triagem. "O dashboard não é o produto...
 * O produto é o incidente." Esta é a tela inicial do app agora
 * (Dashboard vira aba secundária — ver App.jsx e o link "Painel clássico"
 * no cabeçalho abaixo).
 *
 * Layout: lista cross-fleet à esquerda, detalhe (métricas/correção
 * sugerida/mensagens afetadas) no meio, painel de evidência sempre
 * visível à direita — nunca atrás de aba ou clique extra.
 *
 * Aceite da tarefa: alguém que nunca viu o sistema abre o incidente
 * pelo link do Telegram e entende a causa em <60s — cabeçalho, "por
 * que isto virou incidente" e evidência ficam todos visíveis de
 * primeira, sem navegação adicional.
 */
import { LayoutGrid, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { fetchIncident, fetchIncidents, fetchIncidentsSummary, resolveIncident, silenceIncident } from '../api/client'
import { Button } from '@/components/ui/button'
import EvidencePanel from '../components/incidents/EvidencePanel'
import IncidentDetail from '../components/incidents/IncidentDetail'
import IncidentList from '../components/incidents/IncidentList'

const OPEN_STATUSES = new Set(['aberto', 'em_observacao', 'mitigado'])

export default function TriagePage() {
  const navigate = useNavigate()
  const { id: routeId, displayId } = useParams()

  const [status, setStatus]     = useState('open')
  const [severity, setSeverity] = useState('all')
  const [incidents, setIncidents] = useState([])
  const [loading, setLoading]     = useState(true)
  const [summary, setSummary]     = useState(null)
  const [selectedId, setSelectedId] = useState(routeId ? Number(routeId) : null)
  const [detail, setDetail]         = useState(null)
  const listRef = useRef(incidents)
  listRef.current = incidents

  const load = useCallback(() => {
    setLoading(true)
    const params = {}
    if (status !== 'open' && status !== 'all') params.status = status
    if (severity !== 'all') params.severity = severity
    Promise.all([fetchIncidents(params), fetchIncidentsSummary()])
      .then(([rows, sum]) => {
        const filtered = status === 'open' ? rows.filter(r => OPEN_STATUSES.has(r.status)) : rows
        setIncidents(filtered)
        setSummary(sum)
        // Mantém a seleção se ainda existir na lista; senão seleciona o
        // primeiro item — a Triagem nunca fica "em branco" com incidentes na lista.
        setSelectedId(prev => (filtered.some(r => r.id === prev) ? prev : (filtered[0]?.id ?? null)))
      })
      .catch(() => { setIncidents([]); setSummary(null) })
      .finally(() => setLoading(false))
  }, [status, severity])

  useEffect(load, [load])

  // Link de notificação (Telegram/e-mail/webhook) aponta pro display_id
  // ("INC-7"), não pro id numérico interno — resolve contra a lista
  // completa (sem o filtro "open" da tela) porque o incidente notificado
  // pode já ter sido mitigado/resolvido entre o alerta e o clique.
  useEffect(() => {
    if (!displayId) return
    fetchIncidents({}).then(rows => {
      const match = rows.find(r => r.display_id === displayId)
      if (match) { setSelectedId(match.id); navigate(`/triage/${match.id}`, { replace: true }) }
    }).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayId])

  // Poll leve — a Triagem é a tela que fica aberta esperando o próximo
  // incidente aparecer, não só uma tela visitada uma vez.
  useEffect(() => {
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [load])

  useEffect(() => {
    if (selectedId == null) { setDetail(null); return }
    let alive = true
    fetchIncident(selectedId).then(d => { if (alive) setDetail(d) }).catch(() => { if (alive) setDetail(null) })
    navigate(`/triage/${selectedId}`, { replace: true })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  // ── Atalhos J/K/E/S ──────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return
      const rows = listRef.current
      if (rows.length === 0) return
      const idx = rows.findIndex(r => r.id === selectedId)

      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault()
        setSelectedId(rows[Math.min(idx + 1, rows.length - 1)]?.id ?? rows[0].id)
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault()
        setSelectedId(rows[Math.max(idx - 1, 0)]?.id ?? rows[0].id)
      } else if ((e.key === 'e' || e.key === 'E') && selectedId != null) {
        e.preventDefault()
        resolveIncident(selectedId, 'manual').then(load).catch(() => {})
      } else if ((e.key === 's' || e.key === 'S') && selectedId != null) {
        e.preventDefault()
        silenceIncident(selectedId, 60).then(load).catch(() => {})
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [selectedId, load])

  const headline = summary?.headline ?? (loading ? 'Carregando estado da frota…' : 'Entrega normal — nenhum incidente ativo')
  const isDegraded = (summary?.open_critico ?? 0) > 0

  return (
    <div style={{ minHeight: '100vh', background: 'var(--surface)', display: 'flex', flexDirection: 'column' }}>
      <header style={{
        padding: '14px 24px', background: 'var(--card)', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
            background: isDegraded ? 'var(--danger)' : (summary?.open_atencao ? 'var(--warn)' : 'var(--ok)'),
          }} />
          <h1 style={{ fontSize: 15, fontWeight: 800, color: 'var(--text)', margin: 0 }}>{headline}</h1>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={load} disabled={loading}>
            <RefreshCw size={12} style={{ animation: loading ? 'spin 1s linear infinite' : undefined }} /> Atualizar
          </Button>
          <Button size="sm" variant="outline" onClick={() => navigate('/dashboard')}>
            <LayoutGrid size={12} /> Painel clássico
          </Button>
        </div>
      </header>

      <div style={{
        flex: 1, display: 'grid', gridTemplateColumns: 'minmax(260px, 320px) minmax(0, 1fr) minmax(280px, 380px)',
        gap: 14, padding: 16, minHeight: 0,
      }}>
        <div style={{ minHeight: 0 }}>
          <IncidentList
            incidents={incidents} selectedId={selectedId} onSelect={setSelectedId}
            status={status} onStatusChange={setStatus}
            severity={severity} onSeverityChange={setSeverity}
            loading={loading}
          />
        </div>
        <div style={{ minHeight: 0 }}>
          <IncidentDetail incident={detail} onChanged={load} />
        </div>
        <div style={{ minHeight: 0 }}>
          <EvidencePanel incident={detail} />
        </div>
      </div>
    </div>
  )
}
