/**
 * CollectionFreshness — "há quanto tempo o dado na tela foi coletado".
 *
 * O cliente do piloto deixa o painel aberto para monitorar e pediu para
 * saber quando foi a última atualização. O coletor roda sozinho
 * (verificação leve a cada 30s, diagnóstico completo a cada 5min) e o
 * backend expõe `last_collected_at` / `collection_status` em
 * /api/incidents/summary e /api/status/health (health.py).
 *
 * Vive só no header da casca (AppShell) — visível em toda tela. Estava
 * também no cabeçalho da Triagem; o cliente achou redundante e pediu
 * para manter só o do header.
 *
 * Este componente só formata: recebe o timestamp e o status já prontos e
 * faz um tick próprio a cada 10s para o "há Xs" andar sozinho entre um
 * poll e outro. Dois estados por pedido explícito do cliente: check
 * verde quando a coleta está normal, alerta vermelho quando está
 * falhando (ou parada há muito tempo).
 */
import { AlertTriangle, CheckCircle2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const CADENCE_NOTE =
  'O painel coleta sozinho: verificação leve a cada 30s, diagnóstico completo a cada 5min.'

// Sem uma coleta bem-sucedida há mais que isto, tratamos como falha
// mesmo que o ssh_status ainda não tenha virado "error" (ex.: coletor
// travado). 15min = 3x o ciclo completo.
const STALE_LIMIT_S = 900

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

  const diffS = collectedAt
    ? Math.floor((Date.now() - new Date(collectedAt).getTime()) / 1000)
    : null
  const statusFailing = status && status !== 'ok' && status !== 'unknown'
  const failing = statusFailing || diffS == null || diffS >= STALE_LIMIT_S

  const color = failing ? 'var(--danger)' : 'var(--ok)'
  const Icon = failing ? AlertTriangle : CheckCircle2
  let text
  if (diffS == null) text = 'coleta com falha'
  else if (failing) text = `sem atualizar ${ageLabel(diffS)}`
  else text = `coletando · atualizado ${ageLabel(diffS)}`

  const exact = collectedAt
    ? new Date(collectedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' })
    : null

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
        {failing && error ? <><br />Falha: {error}</> : null}
        <br />{CADENCE_NOTE}
      </TooltipContent>
    </Tooltip>
  )
}
