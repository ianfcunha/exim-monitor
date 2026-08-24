/**
 * Vocabulário único de severidade na interface — Sessão 4, Tarefa 10.
 *
 * A Triagem e as notificações de incidente já falavam CRÍTICO/ATENÇÃO;
 * a configuração de alertas e os painéis herdados do script ainda
 * mostravam HIGH/CRITICAL/MEDIUM. Ler "HIGH" numa tela e "ATENÇÃO" na
 * outra sobre o mesmo servidor obriga o usuário a manter uma tabela de
 * conversão na cabeça. CRÍTICO/ATENÇÃO venceu — é o vocabulário da tela
 * que se abre primeiro, e é português (ver backend/app/health.py).
 *
 * Duas escalas alimentam esta função:
 *   - o diagnóstico do script (OK/LOW/MEDIUM/HIGH/CRITICAL/DEGRADED/
 *     UNKNOWN), que chega no snapshot de coleta e no histórico de alertas;
 *   - a severidade de incidente do backend (critico/atencao).
 *
 * O VALOR ARMAZENADO não muda — severity_threshold continua sendo
 * HIGH/CRITICAL no banco, porque é a escala com que o script classifica.
 * O que muda é a palavra que aparece na tela.
 */
export const CRITICO = 'CRÍTICO'
export const ATENCAO = 'ATENÇÃO'
export const NORMAL = 'NORMAL'
export const NAO_VERIFICADO = 'NÃO VERIFICADO'

const LABELS = {
  // Escala do script
  CRITICAL: CRITICO,
  // Log não reconhecido: as métricas não são confiáveis. Continua sendo
  // tratado como o pior caso, não como "não sei" (ver StatusBadge.jsx).
  DEGRADED: CRITICO,
  HIGH: ATENCAO,
  MEDIUM: ATENCAO,
  LOW: NORMAL,
  OK: NORMAL,
  UNKNOWN: NAO_VERIFICADO,
  // Severidade de incidente
  critico: CRITICO,
  atencao: ATENCAO,
  indeterminado: NAO_VERIFICADO,
  ok: NORMAL,
}

export function severityLabel(severity) {
  return LABELS[severity] ?? String(severity ?? '').toUpperCase()
}

/**
 * Sessão 5 — o `problem` do diagnóstico é uma chave do script
 * (FILA_TRAVADA, LOG_NAO_RECONHECIDO, AUTH_ABUSE…) e chegava crua na
 * tela, ao lado de uma severidade já traduzida. Mesma regra da
 * severidade: o valor armazenado não muda, só a palavra exibida.
 */
const PROBLEM_LABELS = {
  NORMAL: 'Nada fora do padrão',
  UNKNOWN: 'Não verificado',
  LOG_NAO_RECONHECIDO: 'Log em formato não reconhecido',
  AUTH_ABUSE: 'Conta comprometida',
  SPAM_RELAY: 'Relay aberto',
  SPAM_MASSIVO: 'Envio massivo',
  ENVIO_THROTTLED: 'Envio limitado pelo destino',
  BOUNCE_CONCENTRADO: 'Devoluções concentradas',
  BOUNCE_STORM: 'Tempestade de devoluções',
  IP_FLOOD: 'Excesso de conexões de um IP',
  FILA_TRAVADA: 'Fila travada',
  FILA_ALTA: 'Fila acima do normal',
  FILA_MENSAGENS_GRANDES: 'Fila com mensagens grandes',
  ALTO_DEFERIMENTO: 'Muitas entregas adiadas',
  ALTA_REJEICAO: 'Muitas entregas rejeitadas',
  ALTO_CONSUMO_RECURSOS: 'Consumo alto de recursos',
  TLD_SUSPEITA: 'Destinos em TLD suspeita',
}

export function problemLabel(problem) {
  if (!problem) return ''
  return PROBLEM_LABELS[problem] ?? String(problem).replace(/_/g, ' ').toLowerCase()
}

/**
 * Tipo de incidente — mesma tradução usada na Triagem, repetida aqui
 * porque o histórico de alertas grava a chave técnica em `problem`
 * ("auth_abuse:opened:INC-113") e precisa desmontá-la.
 */
const INCIDENT_TYPE_LABELS = {
  auth_abuse: 'Conta comprometida',
  queue_stuck: 'Fila travada',
  reputation: 'Reputação',
  dest_deferral: 'Destino adiando entregas',
}

const INCIDENT_EVENT_LABELS = {
  opened: 'aberto',
  escalated: 'agravado',
  resolved: 'resolvido',
}

/**
 * Desmonta "auth_abuse:opened:INC-113" em algo legível, devolvendo
 * também o display_id para a linha poder linkar ao incidente. Alertas
 * de diagnóstico do script (que não seguem esse formato) passam pelo
 * problemLabel() normal.
 */
export function describeAlertProblem(problem) {
  const parts = String(problem ?? '').split(':')
  if (parts.length === 3 && parts[2].startsWith('INC-')) {
    const [type, event, displayId] = parts
    return {
      text: `${INCIDENT_TYPE_LABELS[type] ?? type} · ${INCIDENT_EVENT_LABELS[event] ?? event}`,
      displayId,
    }
  }
  return { text: problemLabel(problem), displayId: null }
}
