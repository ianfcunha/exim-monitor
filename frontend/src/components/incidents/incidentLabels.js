/**
 * Rótulos e estilos compartilhados entre a Triagem (IncidentList/
 * IncidentDetail/EvidencePanel) e o ThresholdEditor.
 *
 * Sessão 4, Tarefa 11 — microcopy. O título de um incidente tem que
 * dizer o FATO, não a chave interna. "Reputação em risco —
 * ip:190.102.43.248" obriga o leitor a traduzir duas coisas (o que é
 * "reputação em risco" e o que é o prefixo "ip:") antes de entender que
 * o IP de saída do servidor dele está numa blocklist. Aqui o mesmo
 * incidente vira "IP 190.102.43.248 listado na Spamhaus ZEN".
 *
 * Nada de `auth_abuse`, `queue_stuck`, `clean-frozen` ou
 * `restore-quarantine` em texto voltado ao usuário — esses nomes são do
 * código e ficam no código.
 */

// Categoria — usada só como etiqueta secundária; o título carrega o fato.
export const TYPE_LABELS = {
  auth_abuse: 'Conta comprometida',
  reputation: 'Reputação de entrega',
  queue_stuck: 'Fila travada',
  dest_deferral: 'Adiamento por destino',
}

// Nome comercial de cada zona DNSBL — "zen.spamhaus.org" é endereço de
// consulta, não o nome que um sysadmin usa para falar dela.
const ZONE_NAMES = {
  'zen.spamhaus.org': 'Spamhaus ZEN',
  'bl.spamcop.net': 'SpamCop',
  'dnsbl.sorbs.net': 'SORBS',
  'b.barracudacentral.org': 'Barracuda',
}

export function zoneName(zone) {
  return ZONE_NAMES[zone] ?? zone
}

// Remove o prefixo técnico da entidade ("ip:", "domain:", "sender:",
// "host:") para uso em texto corrido.
export function entityValue(entity) {
  if (!entity) return ''
  const idx = entity.indexOf(':')
  return idx === -1 ? entity : entity.slice(idx + 1)
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`
}

export function incidentTitle(incident) {
  if (!incident) return ''
  const m = incident.metrics ?? {}
  const value = entityValue(incident.entity)

  switch (`${incident.type}:${incident.subtype ?? ''}`) {
    case 'reputation:blocklist': {
      const zones = (m.blocklists_listed ?? []).map(zoneName)
      if (zones.length === 0) return `IP ${value} listado em blocklist`
      if (zones.length === 1) return `IP ${value} listado na ${zones[0]}`
      return `IP ${value} listado em ${zones.length} blocklists (${zones.join(', ')})`
    }
    case 'reputation:cert': {
      const host = m.hostname || value
      const days = m.days_remaining
      if (typeof days !== 'number') return `Certificado TLS de ${host} precisa de atenção`
      return days < 0
        ? `Certificado TLS de ${host} venceu há ${plural(Math.abs(days), 'dia', 'dias')}`
        : `Certificado TLS de ${host} vence em ${plural(days, 'dia', 'dias')}`
    }
    case 'reputation:dns_auth': {
      const missing = m.missing ?? []
      return `Domínio ${m.domain || value} sem ${missing.join(' e ')}`
    }
    case 'auth_abuse:conta':
      return `Conta ${value} autenticou de ${plural(m.distinct_ips ?? 0, 'IP diferente', 'IPs diferentes')}`
    case 'queue_stuck:fila':
      return `Fila parada em ${plural(m.queue_total ?? 0, 'mensagem', 'mensagens')}`
    case 'queue_stuck:frozen':
      return `${plural(m.frozen_count ?? 0, 'mensagem congelada', 'mensagens congeladas')} na fila`
    case 'dest_deferral:destino':
      return `${m.domain || value} adiando ${Math.round((m.share_of_total ?? 0) * 100)}% das entregas`
    default:
      return `${TYPE_LABELS[incident.type] ?? incident.type} — ${value}`
  }
}

export const SEVERITY_STYLE = {
  critico: { border: 'var(--danger-border)', bg: 'var(--danger-bg)', text: 'var(--danger)', label: 'Crítico' },
  atencao: { border: 'var(--warn-border)', bg: 'var(--warn-bg)', text: 'var(--warn)', label: 'Atenção' },
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

// Rótulo do botão final de apply(). "Remover" nas mensagens vira
// "Enviar para quarentena" — o nome do que de fato acontece. As demais
// ações mantêm um verbo específico, nunca um "Aplicar" genérico.
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
  if (hours < 24) {
    const rest = mins % 60
    return rest ? `${hours}h${rest}min` : `${hours}h`
  }
  return `${Math.floor(hours / 24)}d`
}
