/**
 * CollectionFreshness — "há quanto tempo o dado na tela foi coletado".
 *
 * O cliente do piloto deixa o painel aberto para monitorar e pediu para
 * saber quando foi a última atualização. O coletor roda sozinho
 * (verificação leve a cada 30s, diagnóstico completo a cada 5min) e o
 * backend expõe `last_collected_at` / `collection_status` em
 * /api/incidents/summary e /api/status/health (health.py).
 *
 * Este componente só formata: recebe o timestamp e o status já prontos,
 * e faz um tick próprio a cada 10s para o "há Xs" andar sozinho mesmo
 * entre um poll e outro. Cor: normal enquanto está dentro da cadência
 * esperada, âmbar quando passou do previsto, vermelho quando a coleta
 * está claramente parada ou falhando.
 */
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const CADENCE_NOTE =
  'O painel coleta sozinho: verificação leve a cada 30s, diagnóstico completo a cada 5min.'

function ageLabel(diffS) {
  if (diffS < 60) return `há ${Math.max(diffS, 0)}s`
  const m = Math.floor(diffS / 60)
  if (m < 60) return `há ${m}min`
  const h = Math.floor(m / 60)
  if (h < 24) return `há ${h}h`
  return `há ${Math.floor(h / 24)}d`
}

export default function CollectionFreshness({ collectedAt, status, error }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick(n => n + 1), 10_000)
    return () => clearInterval(id)
  }, [])

  const failing = status && status !== 'ok' && status !== 'unknown'
  const diffS = collectedAt
    ? Math.floor((Date.now() - new Date(collectedAt).getTime()) / 1000)
    : null

  let color = 'var(--dim)'
  let text
  if (diffS == null) {
    color = failing ? 'var(--danger)' : 'var(--dim)'
    text = failing ? 'coleta com falha' : 'sem coleta ainda'
  } else {
    text = `atualizado ${ageLabel(diffS)}`
    if (failing || diffS >= 900) {
      color = 'var(--danger)'
      if (failing) text = `sem atualizar ${ageLabel(diffS)}`
    } else if (diffS >= 360) {
      color = 'var(--warn)'
    }
  }

  const exact = collectedAt
    ? new Date(collectedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' })
    : null
  const Icon = (failing || (diffS != null && diffS >= 900)) ? AlertTriangle : RefreshCw

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="flex items-center gap-1.5"
          style={{ fontSize: 11, color, whiteSpace: 'nowrap', flexShrink: 0, cursor: 'default' }}
        >
          <Icon size={12} />
          {text}
        </div>
      </TooltipTrigger>
      <TooltipContent style={{ maxWidth: 300 }}>
        {exact
          ? <>Última coleta bem-sucedida: <strong>{exact}</strong>.</>
          : 'Ainda não houve uma coleta bem-sucedida neste escopo.'}
        {failing && error ? <><br />Falha atual: {error}</> : null}
        <br />{CADENCE_NOTE}
      </TooltipContent>
    </Tooltip>
  )
}
