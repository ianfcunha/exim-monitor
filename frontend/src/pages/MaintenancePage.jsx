/**
 * MaintenancePage — Tarefa 3 (Sessão 1, pós-auditoria).
 *
 * "Limpar toda a fila" saiu do painel principal (ActionPanel) — é a
 * única ação de escopo total (a fila inteira, não um filtro por
 * remetente/IP/frozen), então mora aqui, atrás de: plan() com preview
 * real, e apply() só liberado depois de digitar o nome exato do
 * servidor. Mesmo plan_id de 5 minutos, mesma quarentena, mesmo
 * apply() do resto do painel — só o caminho até chegar lá é mais
 * pesado de propósito.
 *
 * Também lista os incidentes de quarentena ativos (de qualquer ação,
 * não só "limpar toda a fila") com restauração de um clique.
 */
import { AlertTriangle, ArrowLeft, Loader2, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchQuarantine, planAction, restoreQuarantine, runAction } from '../api/client'
import { Button } from '@/components/ui/button'
import { useServer } from '../contexts/ServerContext'
import { useToast } from '../contexts/ToastContext'

function fmtRelative(epochSeconds) {
  const diffMs = epochSeconds * 1000 - Date.now()
  const days = Math.round(diffMs / 86_400_000)
  if (days <= 0) return 'expira a qualquer momento'
  if (days === 1) return 'expira em 1 dia'
  return `expira em ${days} dias`
}

export default function MaintenancePage() {
  const navigate = useNavigate()
  const toast = useToast()
  const { activeServer } = useServer()

  const [plan, setPlan]         = useState(null)
  const [planning, setPlanning] = useState(false)
  const [applying, setApplying] = useState(false)
  const [confirmName, setConfirmName] = useState('')

  const [incidents, setIncidents]         = useState([])
  const [loadingIncidents, setLoadingIncidents] = useState(true)
  const [restoringId, setRestoringId]     = useState(null)

  const loadIncidents = () => {
    if (!activeServer) { setIncidents([]); setLoadingIncidents(false); return }
    setLoadingIncidents(true)
    fetchQuarantine(activeServer.id)
      .then(setIncidents)
      .catch(() => setIncidents([]))
      .finally(() => setLoadingIncidents(false))
  }

  useEffect(loadIncidents, [activeServer])

  const requestPlan = async () => {
    if (!activeServer) return
    setPlanning(true)
    try {
      const res = await planAction('clean-full', null, activeServer.id)
      setPlan(res)
      setConfirmName('')
    } catch (err) {
      toast({ type: 'err', msg: err?.response?.data?.detail || err.message || 'Erro ao planejar.' })
    } finally {
      setPlanning(false)
    }
  }

  const cancelPlan = () => { setPlan(null); setConfirmName('') }

  const nameMatches = plan && activeServer && confirmName.trim() === activeServer.name

  const applyClean = async () => {
    if (!nameMatches) return
    setApplying(true)
    try {
      const res = await runAction('clean-full', null, activeServer.id, true, plan.plan_id)
      toast({ type: 'ok', msg: res.message || 'Fila limpa.' })
      loadIncidents()
    } catch (err) {
      toast({ type: 'err', msg: err?.response?.data?.detail || err.message || 'Erro ao executar.' })
    } finally {
      setApplying(false)
      setPlan(null)
      setConfirmName('')
    }
  }

  const restore = async (incident) => {
    if (!activeServer) return
    setRestoringId(incident)
    try {
      const res = await restoreQuarantine(incident, activeServer.id)
      toast({ type: 'ok', msg: res.message || 'Incidente restaurado.' })
      loadIncidents()
    } catch (err) {
      toast({ type: 'err', msg: err?.response?.data?.detail || err.message || 'Erro ao restaurar.' })
    } finally {
      setRestoringId(null)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <button
        onClick={() => navigate('/settings')}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
          fontSize: 12, color: 'var(--dim)', background: 'none', border: 'none', cursor: 'pointer', padding: 0,
        }}
      >
        <ArrowLeft size={14} /> Configurações
      </button>

      <p style={{ fontSize: 10, letterSpacing: '0.30em', textTransform: 'uppercase', color: 'var(--danger)', fontWeight: 700 }}>
        Zona de risco
      </p>

      {/* ── Limpar toda a fila ─────────────────────────────────────── */}
      <div style={{
        background: 'var(--card)', border: '1px solid var(--danger-border)', borderRadius: 12,
        padding: '20px 20px 16px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <Trash2 size={16} color="var(--danger)" />
          <h2 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Limpar toda a fila</h2>
        </div>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14, lineHeight: 1.5 }}>
          Remove <strong>todas</strong> as mensagens da fila do servidor selecionado — não um filtro por
          remetente, IP ou frozen. As mensagens vão para quarentena (retenção padrão de 7 dias) antes da
          remoção definitiva, e podem ser restauradas na seção abaixo enquanto isso.
        </p>

        {!activeServer ? (
          <p style={{ fontSize: 12, color: 'var(--dim)' }}>Selecione um servidor no dashboard primeiro.</p>
        ) : !plan ? (
          <Button
            size="sm"
            onClick={requestPlan}
            disabled={planning}
            className="border-transparent bg-red-600 text-white shadow-sm hover:bg-red-700 hover:text-white active:bg-red-800"
          >
            {planning ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
            {planning ? 'Planejando…' : `Ver plano para ${activeServer.name}`}
          </Button>
        ) : (
          <div style={{
            borderRadius: 10, padding: '12px 14px',
            background: 'var(--danger-bg)', border: '1px solid var(--danger-border)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <AlertTriangle size={13} color="var(--danger)" />
              <span style={{ fontSize: 12, color: 'var(--danger)' }}>{plan.preview?.message}</span>
            </div>
            <label style={{ display: 'block', fontSize: 11, color: 'var(--danger)', marginBottom: 6 }}>
              Digite o nome exato do servidor (<strong>{activeServer.name}</strong>) para confirmar:
            </label>
            <input
              type="text"
              autoFocus
              value={confirmName}
              onChange={e => setConfirmName(e.target.value)}
              placeholder={activeServer.name}
              style={{
                width: '100%', boxSizing: 'border-box', marginBottom: 10,
                borderRadius: 7, border: '1px solid var(--danger-border)',
                padding: '6px 10px', fontSize: 12, color: 'var(--text)',
                background: 'var(--card)', outline: 'none',
              }}
            />
            <div className="flex gap-2">
              <Button
                variant="destructive"
                size="sm"
                onClick={applyClean}
                disabled={!nameMatches || applying}
                className="border-transparent bg-red-600 text-white shadow-sm hover:bg-red-700 hover:text-white active:bg-red-800 disabled:opacity-40"
              >
                {applying ? 'Aplicando…' : 'Aplicar agora'}
              </Button>
              <Button variant="outline" size="sm" onClick={cancelPlan}>Cancelar</Button>
            </div>
          </div>
        )}
      </div>

      {/* ── Quarentena ──────────────────────────────────────────────── */}
      <div style={{
        background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
        padding: '20px 20px 16px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
      }}>
        <h2 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: '0 0 4px' }}>
          Quarentena de mensagens
        </h2>
        <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 14 }}>
          Mensagens removidas por qualquer ação destrutiva (não só a limpeza total) ficam aqui até a
          retenção expirar. Restaurar devolve as mesmas mensagens para a fila real.
        </p>

        {loadingIncidents ? (
          <p style={{ fontSize: 12, color: 'var(--dim)' }}>Carregando…</p>
        ) : incidents.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--dim)' }}>Nenhum incidente em quarentena.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {incidents.map((inc) => (
              <div key={inc.incident} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)',
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11.5, color: 'var(--text)', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {inc.incident}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--dim)' }}>
                    {inc.count} mensagen{inc.count === 1 ? '' : 's'} — {fmtRelative(inc.expires_at)}
                  </div>
                </div>
                <Button
                  size="sm" variant="outline"
                  onClick={() => restore(inc.incident)}
                  disabled={restoringId === inc.incident}
                >
                  <RotateCcw size={11} />
                  {restoringId === inc.incident ? 'Restaurando…' : 'Restaurar'}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
