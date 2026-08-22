/**
 * Sessão 2, Tarefa 6 — "Configuração de threshold por tipo em formulário
 * simples basta" (instrução explícita: NÃO construir uma aba "Regras").
 * Um popover com um campo numérico por threshold do tipo, aberto a
 * partir do "por que isto virou incidente" no detalhe do incidente.
 */
import { useEffect, useState } from 'react'
import { fetchIncidentConfig, saveIncidentConfig } from '../../api/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '../../contexts/ToastContext'
import { TYPE_LABELS } from './incidentLabels'

const FIELD_LABELS = {
  distinct_ips_threshold: 'IPs distintos', volume_multiplier: 'Múltiplo do baseline (volume)',
  min_baseline_samples: 'Amostras mínimas de baseline', min_count_for_volume_check: 'Volume mínimo p/ checar',
  cert_days_warn: 'Dias p/ alertar cert expirando', min_volume_for_dns_check: 'Volume mínimo p/ checar SPF/DKIM/DMARC',
  consecutive_cycles: 'Ciclos consecutivos (fila)', growth_multiplier: 'Múltiplo do baseline (fila)',
  min_queue_floor: 'Piso mínimo (fila)', frozen_consecutive_cycles: 'Ciclos consecutivos (frozen)',
  frozen_growth_multiplier: 'Múltiplo do baseline (frozen)', frozen_min_floor: 'Piso mínimo (frozen)',
  min_count: 'Contagem mínima', min_share: 'Fração mínima do total (0–1)',
}

export default function ThresholdEditor({ serverId, type, onClose }) {
  const toast = useToast()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [values, setValues]   = useState({})
  const [defaults, setDefaults] = useState({})

  useEffect(() => {
    let alive = true
    fetchIncidentConfig(serverId).then(cfg => {
      if (!alive) return
      const entry = cfg[type] ?? { defaults: {}, effective: {} }
      setDefaults(entry.defaults)
      setValues(entry.effective)
      setLoading(false)
    }).catch(() => setLoading(false))
    return () => { alive = false }
  }, [serverId, type])

  const save = async () => {
    setSaving(true)
    try {
      const thresholds = {}
      for (const k of Object.keys(defaults)) thresholds[k] = Number(values[k])
      await saveIncidentConfig(serverId, type, thresholds)
      toast({ type: 'ok', msg: 'Thresholds salvos.' })
      onClose?.()
    } catch (err) {
      toast({ type: 'err', msg: err?.response?.data?.detail || 'Erro ao salvar.' })
    } finally {
      setSaving(false)
    }
  }

  const reset = () => setValues({ ...defaults })

  if (loading) return <div style={{ fontSize: 12, color: 'var(--dim)', padding: 8 }}>Carregando…</div>

  return (
    <div style={{ width: 260 }}>
      <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--text)', marginBottom: 8 }}>
        Thresholds — {TYPE_LABELS[type] ?? type}
      </div>
      <div className="space-y-2">
        {Object.keys(defaults).map(k => (
          <div key={k}>
            <Label style={{ fontSize: 10, color: 'var(--dim)' }}>{FIELD_LABELS[k] ?? k}</Label>
            <Input
              type="number" step="any"
              value={values[k] ?? ''}
              onChange={e => setValues(v => ({ ...v, [k]: e.target.value }))}
              style={{ fontSize: 12, height: 28 }}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-2" style={{ marginTop: 10 }}>
        <Button size="sm" onClick={save} disabled={saving}>{saving ? 'Salvando…' : 'Salvar'}</Button>
        <Button size="sm" variant="outline" onClick={reset} disabled={saving}>Restaurar padrão</Button>
      </div>
    </div>
  )
}
