/**
 * Sessão 2, Tarefa 6 — rótulos/estilos compartilhados entre a Triagem
 * (IncidentList/IncidentDetail) e o ThresholdEditor, pra não duplicar o
 * mapa de tipos em dois arquivos.
 */

export const TYPE_LABELS = {
  auth_abuse: 'Conta comprometida', reputation: 'Reputação em risco',
  queue_stuck: 'Fila travada', dest_deferral: 'Rate limit de destino',
}

export const SEVERITY_STYLE = {
  critico: { border: 'var(--danger-border)', bg: 'var(--danger-bg)', text: 'var(--danger)' },
  atencao: { border: 'var(--warn-border)', bg: 'var(--warn-bg)', text: 'var(--warn)' },
}

export const STATUS_LABELS = {
  aberto: 'Aberto', em_observacao: 'Em observação', mitigado: 'Mitigado', resolvido: 'Resolvido',
}

export const STATUS_STYLE = {
  aberto:        { border: 'var(--danger-border)', bg: 'var(--danger-bg)', text: 'var(--danger)' },
  em_observacao: { border: 'var(--border)', bg: 'var(--surface)', text: 'var(--dim)' },
  mitigado:      { border: 'var(--accent-border)', bg: 'var(--accent-bg)', text: 'var(--accent-fg)' },
  resolvido:     { border: 'var(--ok-border)', bg: 'var(--ok-bg)', text: 'var(--ok)' },
}

// Rótulo do botão final de apply() — "Remover" nas mensagens vira
// "Enviar para quarentena" (instrução explícita da Tarefa 6); as demais
// ações mantêm um rótulo específico da ação, não um "Aplicar" genérico.
export function applyLabel(action) {
  if (!action) return 'Aplicar agora'
  if (action.startsWith('clean-')) return 'Enviar para quarentena'
  if (action === 'block-ip') return 'Bloquear IP'
  if (action === 'retry-queue') return 'Reprocessar fila'
  return 'Aplicar agora'
}

export function fmtAge(iso) {
  if (!iso) return '—'
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 1) return 'agora'
  if (mins < 60) return `${mins}min`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
