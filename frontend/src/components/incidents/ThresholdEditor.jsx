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

// label = o que o número controla, em português claro.
// hint  = uma linha explicando o efeito de mexer nele.
const FIELD_META = {
  // auth_abuse
  distinct_ips_threshold: {
    label: 'IPs diferentes na mesma conta',
    hint: 'Quantos IPs distintos uma conta pode usar para enviar antes de virar suspeita de senha vazada.',
  },
  volume_multiplier: {
    label: 'Volume acima do normal (vezes)',
    hint: 'Comparado com o volume habitual da conta. 2 = alerta quando ela envia o dobro do normal.',
  },
  min_baseline_samples: {
    label: 'Dias de histórico necessários',
    hint: 'Sem esse mínimo de histórico o painel não tem "normal" para comparar e não alerta por volume.',
  },
  min_count_for_volume_check: {
    label: 'Envios mínimos para avaliar volume',
    hint: 'Abaixo disso, poucos envios — não vale a pena comparar com o normal.',
  },
  // reputation
  cert_days_warn: {
    label: 'Avisar com quantos dias de antecedência',
    hint: 'Abre incidente quando o certificado TLS está a esse número de dias de vencer.',
  },
  min_volume_for_dns_check: {
    label: 'Envios mínimos para checar SPF/DKIM/DMARC',
    hint: 'Domínios que quase não enviam não são checados — evita ruído.',
  },
  // queue_stuck — fila
  consecutive_cycles: {
    label: 'Leituras seguidas com a fila parada',
    hint: 'Cada leitura completa é a cada ~5 min. 3 = o painel confirma por ~15 min antes de abrir o incidente.',
  },
  growth_multiplier: {
    label: 'Fila acima do normal (vezes)',
    hint: 'Comparado com a média deste servidor no mesmo horário. 2 = fila com o dobro do habitual.',
  },
  min_queue_floor: {
    label: 'Fila mínima para alertar',
    hint: 'Abaixo desse número de mensagens nunca abre incidente — evita alarme com fila pequena.',
  },
  // queue_stuck — congeladas
  frozen_consecutive_cycles: {
    label: 'Leituras seguidas com mensagens congeladas',
    hint: 'Mesma ideia da fila: quantas leituras confirmando antes de abrir o incidente.',
  },
  frozen_growth_multiplier: {
    label: 'Congeladas acima do normal (vezes)',
    hint: 'Comparado com a média deste servidor no mesmo horário.',
  },
  frozen_min_floor: {
    label: 'Mínimo de congeladas para alertar',
    hint: 'Abaixo desse número nunca abre incidente.',
  },
  // dest_deferral
  min_count: {
    label: 'Adiamentos mínimos para avaliar',
    hint: 'Abaixo disso são poucos adiamentos — pode ser normal.',
  },
  min_share: {
    label: 'Fração das entregas adiadas (0 a 1)',
    hint: '0.4 = alerta quando 40% das entregas para aquele destino estão sendo adiadas.',
  },
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
      toast({ type: 'ok', msg: 'Ajustes salvos para este servidor.' })
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
    <div style={{ width: 300 }}>
      <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--text)', marginBottom: 2 }}>
        Quando abrir incidente de {(TYPE_LABELS[type] ?? type).toLowerCase()}
      </div>
      <div style={{ fontSize: 10.5, color: 'var(--dim)', marginBottom: 10, lineHeight: 1.4 }}>
        Vale só para este servidor. Números maiores = alerta mais tarde e com menos ruído.
      </div>
      <div className="space-y-3">
        {Object.keys(defaults).map(k => {
          const meta = FIELD_META[k] ?? { label: k, hint: null }
          return (
            <div key={k}>
              <Label style={{ fontSize: 11, color: 'var(--text)', fontWeight: 600 }}>{meta.label}</Label>
              <Input
                type="number" step="any"
                value={values[k] ?? ''}
                onChange={e => setValues(v => ({ ...v, [k]: e.target.value }))}
                style={{ fontSize: 12, height: 28, marginTop: 2 }}
              />
              {meta.hint && (
                <div style={{ fontSize: 10, color: 'var(--dim)', marginTop: 3, lineHeight: 1.4 }}>{meta.hint}</div>
              )}
            </div>
          )
        })}
      </div>
      <div className="flex gap-2" style={{ marginTop: 12 }}>
        <Button size="sm" onClick={save} disabled={saving}>{saving ? 'Salvando…' : 'Salvar'}</Button>
        <Button size="sm" variant="outline" onClick={reset} disabled={saving}>Restaurar padrão</Button>
      </div>
    </div>
  )
}
