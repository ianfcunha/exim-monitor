/**
 * LicenseCard — bloco "Licença" em Configurações → Geral (admin only).
 *
 * Mostra o que o suporte vai perguntar primeiro: cliente, vencimento,
 * quantos servidores estão em uso do total contratado. E diz, em letras
 * miúdas mas sempre presentes, o que uma licença vencida NÃO faz — a
 * política soft só é tranquilizadora se estiver escrita onde o cliente lê.
 */
import { BadgeCheck, Clock, ShieldAlert, ShieldQuestion } from 'lucide-react'
import { useLicense } from '../contexts/LicenseContext'

const STATE = {
  ok:       { label: 'Ativa',        fg: 'var(--ok)',     bg: 'var(--ok-bg)',     Icon: BadgeCheck },
  expiring: { label: 'Vence em breve', fg: 'var(--warn)', bg: 'var(--warn-bg)',   Icon: Clock },
  expired:  { label: 'Vencida',      fg: 'var(--danger)', bg: 'var(--danger-bg)', Icon: ShieldAlert },
  invalid:  { label: 'Inválida',     fg: 'var(--danger)', bg: 'var(--danger-bg)', Icon: ShieldAlert },
  missing:  { label: 'Cortesia',     fg: 'var(--warn)',   bg: 'var(--warn-bg)',   Icon: ShieldQuestion },
}

function Row({ label, children }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '6px 0' }}>
      <span style={{ fontSize: 11.5, color: 'var(--dim)', width: 130, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 12.5, color: 'var(--text)', minWidth: 0 }}>{children}</span>
    </div>
  )
}

export default function LicenseCard() {
  const { license } = useLicense()
  if (!license) return null

  const s = STATE[license.state] ?? STATE.invalid
  const { Icon } = s
  const dias = license.days_left ?? 0
  const noTeto = license.servers_used >= license.max_servers

  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
      padding: '20px 20px 16px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
        <p style={{ fontSize: 10, letterSpacing: '0.30em', textTransform: 'uppercase', color: 'var(--sky)', fontWeight: 700, margin: 0 }}>
          Licença
        </p>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          padding: '3px 9px', borderRadius: 999, background: s.bg, color: s.fg,
          fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap',
        }}>
          <Icon size={12} /> {s.label}
        </span>
      </div>

      {license.state === 'missing' ? (
        <Row label="Instalação">
          Sem licença configurada — período de cortesia
          {dias > 0 ? `, ${dias} dia${dias === 1 ? '' : 's'} restante${dias === 1 ? '' : 's'}` : ' encerrado'}.
        </Row>
      ) : license.state === 'invalid' ? (
        <Row label="Token">O token em <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5 }}>MAILIQ_LICENSE</code> não pôde ser validado.</Row>
      ) : (
        <>
          <Row label="Cliente">{license.customer || '—'}</Row>
          <Row label="Licença">
            <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, color: 'var(--muted)' }}>
              {license.license_id || '—'}
            </code>
          </Row>
          <Row label={license.state === 'expired' ? 'Venceu em' : 'Válida até'}>
            {license.expires_at ? new Date(license.expires_at).toLocaleDateString('pt-BR') : '—'}
            {license.state !== 'expired' && dias > 0 && (
              <span style={{ color: 'var(--dim)' }}> · faltam {dias} dia{dias === 1 ? '' : 's'}</span>
            )}
          </Row>
        </>
      )}

      <Row label="Servidores">
        <span style={{ color: noTeto ? s.fg : 'var(--text)', fontWeight: noTeto ? 700 : 400 }}>
          {license.servers_used} de {license.max_servers}
        </span>
        {noTeto && <span style={{ color: 'var(--dim)' }}> · limite atingido</span>}
      </Row>

      {license.features?.length > 0 && (
        <Row label="Recursos">{license.features.join(', ')}</Row>
      )}

      <div style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 10 }}>
        <p style={{ fontSize: 11, color: 'var(--dim)', margin: 0, lineHeight: 1.55 }}>
          {license.can_add_server ? (
            <>
              A licença é conferida no próprio servidor, sem consultar a internet.
              Licença vencida ou ausente <strong>não</strong> desliga o painel, não o
              deixa somente-leitura e não interrompe a coleta — o único efeito é
              suspender o cadastro de servidores novos.
            </>
          ) : (
            // O texto vem pronto do backend — o mesmo que o POST /api/servers
            // responde. Repetir aqui a tranquilizadora "os já cadastrados
            // continuam" duplicaria o que a própria frase já diz.
            <strong style={{ color: s.fg }}>{license.block_reason}</strong>
          )}
        </p>
      </div>
    </div>
  )
}
