/**
 * Painel de evidência. "É ele que faz um sysadmin sênior confiar em vez
 * de tratar o produto como caixa-preta. Não é enfeite — é o item mais
 * importante da tela" — por isso fica sempre visível ao lado do
 * detalhe, nunca atrás de um clique ou aba, e nunca colapsado.
 *
 * Sessão 4, Tarefa 7 — evidência POR TIPO. Antes, a evidência era
 * sempre "linhas do mainlog", e quando não havia nenhuma o painel dizia
 * "log pode ter rotacionado". Para um incidente de reputação isso era
 * duplamente errado: a evidência nunca estaria no mainlog (a prova é a
 * consulta DNS), e a mensagem sugeria uma falha de coleta que não
 * aconteceu.
 *
 * Agora cada tipo define a própria evidência:
 *   auth_abuse / queue_stuck / dest_deferral → linhas de log
 *   reputation (blocklist)  → zona consultada, resposta bruta, resolver,
 *                             horário e histórico das últimas checagens
 *   reputation (dns_auth)   → os registros DNS conferidos
 *   reputation (cert)       → cadeia, emissor, validade e hostname usado
 *
 * E quando não há evidência, o motivo é específico — nunca um genérico
 * que sugere falha de coleta.
 */
import { zoneName } from './incidentLabels'

const PANEL = {
  display: 'flex', flexDirection: 'column', height: '100%',
  background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
  overflow: 'hidden',
}

const MONO = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 10.5, lineHeight: 1.6, wordBreak: 'break-all',
}

function Empty({ children }) {
  return <div style={{ padding: 14, fontSize: 12, color: 'var(--dim)', lineHeight: 1.5 }}>{children}</div>
}

function Field({ label, value, mono = false }) {
  if (value == null || value === '') return null
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 9.5, color: 'var(--dim)', textTransform: 'uppercase',
                    letterSpacing: '0.05em', marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text)', ...(mono ? MONO : {}), wordBreak: 'break-word' }}>
        {String(value)}
      </div>
    </div>
  )
}

function fmtTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('pt-BR')
}

const ZONE_STATUS_STYLE = {
  listado:      { color: 'var(--danger)', label: 'Listado' },
  limpo:        { color: 'var(--ok)', label: 'Limpo' },
  desconhecido: { color: 'var(--dim)', label: 'Não verificável' },
}

function DnsblEvidence({ evidence }) {
  const zones = evidence.zones ?? []
  const history = evidence.history ?? []
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
      <Field label="IP consultado" value={evidence.ip} mono />
      <Field label="Resolver usado" value={evidence.resolver || 'nenhum resolver conseguiu consultar'} mono />

      <div style={{ fontSize: 9.5, color: 'var(--dim)', textTransform: 'uppercase',
                    letterSpacing: '0.05em', margin: '12px 0 5px' }}>
        Consultas desta checagem
      </div>
      {zones.length === 0 ? (
        <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Nenhuma zona foi consultada.</div>
      ) : zones.map((z, i) => {
        const st = ZONE_STATUS_STYLE[z.status] ?? ZONE_STATUS_STYLE.desconhecido
        return (
          <div key={i} style={{
            marginBottom: 8, padding: '7px 9px', borderRadius: 7,
            border: '1px solid var(--border)', background: 'var(--surface)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: st.color }} />
              <strong style={{ fontSize: 11.5, color: 'var(--text)' }}>{zoneName(z.list)}</strong>
              <span style={{ marginLeft: 'auto', fontSize: 10, color: st.color, fontWeight: 600 }}>{st.label}</span>
            </div>
            <div style={{ ...MONO, color: 'var(--muted)', fontSize: 10 }}>{z.zone}</div>
            <div style={{ ...MONO, color: 'var(--text)', fontSize: 10, marginTop: 2 }}>
              resposta: {z.raw ? z.raw : '(vazia — NXDOMAIN)'}
            </div>
            {z.reason && (
              <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.4 }}>{z.reason}</div>
            )}
          </div>
        )
      })}

      {history.length > 0 && (
        <>
          <div style={{ fontSize: 9.5, color: 'var(--dim)', textTransform: 'uppercase',
                        letterSpacing: '0.05em', margin: '12px 0 5px' }}>
            Últimas {history.length} checagens
          </div>
          {history.map((h, i) => {
            const st = ZONE_STATUS_STYLE[h.status === 'critico' ? 'listado' : h.status === 'ok' ? 'limpo' : 'desconhecido']
            return (
              <div key={i} style={{ display: 'flex', gap: 8, fontSize: 10.5, marginBottom: 3 }}>
                <span style={{ color: 'var(--dim)', flexShrink: 0, ...MONO }}>{fmtTime(h.at)}</span>
                <span style={{ color: st.color, fontWeight: 600 }}>{st.label}</span>
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}

function CertEvidence({ evidence }) {
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
      <Field label="Hostname verificado" value={evidence.hostname} mono />
      <Field
        label="Como o hostname foi descoberto"
        value={{
          smtp_banner: 'Banner SMTP do próprio servidor',
          reverse_dns: 'DNS reverso do IP de saída',
          mx: 'Registro MX do domínio',
          parametro: 'Informado manualmente',
          none: 'Não foi possível descobrir',
        }[evidence.hostname_source] ?? evidence.hostname_source}
      />
      <Field label="SNI enviado no handshake" value={evidence.sni_sent ? 'sim' : 'não'} />
      <Field label="Emissor" value={evidence.issuer} mono />
      <Field label="Titular" value={evidence.subject} mono />
      <Field label="Outros nomes no certificado" value={evidence.sans} mono />
      <Field label="Válido a partir de" value={evidence.starts_at ? fmtTime(evidence.starts_at) : null} />
      <Field label="Válido até" value={evidence.expires_at ? fmtTime(evidence.expires_at) : null} />
      {evidence.not_after_raw && !evidence.expires_at && (
        <Field label="Data bruta de validade (não interpretável)" value={evidence.not_after_raw} mono />
      )}
      {evidence.hostname_matches === false && (
        <div style={{
          marginTop: 8, padding: '8px 10px', borderRadius: 7, fontSize: 11.5,
          background: 'var(--warn-bg)', border: '1px solid var(--warn-border)', color: 'var(--warn)',
        }}>
          O certificado apresentado não cobre <strong>{evidence.hostname}</strong> — provedores que
          exigem TLS verificado vão recusar a entrega.
        </div>
      )}
    </div>
  )
}

function DnsAuthEvidence({ evidence }) {
  const records = evidence.records ?? {}
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
      <Field label="Domínio consultado" value={evidence.domain} mono />
      {['spf', 'dkim', 'dmarc'].map(key => {
        const rec = records[key] ?? {}
        return (
          <div key={key} style={{
            marginBottom: 8, padding: '7px 9px', borderRadius: 7,
            border: '1px solid var(--border)', background: 'var(--surface)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <span style={{
                width: 6, height: 6, borderRadius: '50%',
                background: rec.found ? 'var(--ok)' : 'var(--danger)',
              }} />
              <strong style={{ fontSize: 11.5, color: 'var(--text)' }}>{key.toUpperCase()}</strong>
              <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 600,
                             color: rec.found ? 'var(--ok)' : 'var(--danger)' }}>
                {rec.found ? 'encontrado' : 'ausente'}
              </span>
            </div>
            {rec.record && <div style={{ ...MONO, color: 'var(--muted)' }}>{rec.record}</div>}
          </div>
        )
      })}
    </div>
  )
}

function LogEvidence({ evidence }) {
  const lines = evidence.lines ?? []
  if (lines.length === 0) {
    return (
      <Empty>
        {evidence.unavailable_reason
          ?? 'Nenhuma linha de log foi capturada para este incidente.'}
      </Empty>
    )
  }
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '8px 0' }}>
      {lines.map((line, i) => (
        <div
          key={i}
          style={{ ...MONO, color: 'var(--muted)', padding: '3px 14px',
                   whiteSpace: 'pre-wrap', borderLeft: '2px solid transparent' }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface)'; e.currentTarget.style.borderLeftColor = 'var(--sky)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderLeftColor = 'transparent' }}
        >
          {line}
        </div>
      ))}
    </div>
  )
}

const KIND_SUBTITLE = {
  log_lines: 'linhas do log de correio',
  dnsbl: 'consultas DNS às blocklists',
  dns_auth: 'registros DNS do domínio',
  cert: 'certificado apresentado pelo servidor',
}

export default function EvidencePanel({ incident }) {
  const evidence = incident?.evidence ?? null
  // Evidências gravadas antes da Sessão 4 não têm `kind`; eram sempre
  // linhas de log.
  const kind = evidence?.kind ?? (evidence?.lines ? 'log_lines' : null)

  return (
    <div style={PANEL}>
      <div style={{
        padding: '12px 14px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 8, flexShrink: 0,
      }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>Evidência</span>
        {kind && (
          <span style={{ fontSize: 10, color: 'var(--dim)', textAlign: 'right' }}>
            {KIND_SUBTITLE[kind] ?? ''}
          </span>
        )}
      </div>

      {!incident ? (
        <Empty>Selecione um incidente para ver a prova do diagnóstico.</Empty>
      ) : !evidence ? (
        <Empty>Nenhuma evidência foi registrada na abertura deste incidente.</Empty>
      ) : kind === 'dnsbl' ? (
        <DnsblEvidence evidence={evidence} />
      ) : kind === 'cert' ? (
        <CertEvidence evidence={evidence} />
      ) : kind === 'dns_auth' ? (
        <DnsAuthEvidence evidence={evidence} />
      ) : kind === 'log_lines' ? (
        <LogEvidence evidence={evidence} />
      ) : (
        <Empty>
          {evidence.unavailable_reason
            ?? 'Este tipo de incidente não define uma fonte de evidência.'}
        </Empty>
      )}
    </div>
  )
}
