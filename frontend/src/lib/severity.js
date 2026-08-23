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
