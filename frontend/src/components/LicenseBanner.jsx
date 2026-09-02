/**
 * LicenseBanner — faixa no topo do painel quando a licença não está `ok`.
 *
 * Aparece só para admin (viewer não vê licença) e some completamente no
 * estado `ok` — ninguém precisa de um lembrete diário de que está tudo
 * certo. Âmbar quando ainda dá tempo de agir (vence em ≤14 dias, cortesia
 * correndo), vermelho quando já passou do prazo ou o token não confere.
 *
 * O texto diz sempre a mesma coisa em duas partes: o que aconteceu, e o
 * que NÃO acontece por causa disso. A segunda metade importa tanto quanto
 * a primeira — quem lê "licença vencida" num painel de produção precisa
 * saber, na mesma frase, que o monitoramento não parou.
 */
import { Clock, ShieldAlert } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { useLicense } from '../contexts/LicenseContext'

const TONE = {
  amber: { bg: 'var(--warn-bg)',   border: 'var(--warn-border)',   fg: 'var(--warn)',   Icon: Clock },
  red:   { bg: 'var(--danger-bg)', border: 'var(--danger-border)', fg: 'var(--danger)', Icon: ShieldAlert },
}

function describe(lic) {
  const dias = lic.days_left ?? 0
  const plural = dias === 1 ? 'dia' : 'dias'

  if (lic.state === 'invalid') return {
    tone: 'red',
    title: 'A licença deste painel não pôde ser validada.',
    body: 'O monitoramento continua normal — nenhum servidor foi desligado e nenhum dado foi perdido. Só o cadastro de servidores novos está suspenso. Fale com o suporte para receber um token válido.',
  }

  if (lic.state === 'expired') return {
    tone: 'red',
    title: `Licença vencida${lic.expires_at ? ` em ${new Date(lic.expires_at).toLocaleDateString('pt-BR')}` : ''}.`,
    body: 'O monitoramento dos servidores já cadastrados continua normal. Enquanto a licença não for renovada, apenas o cadastro de servidores novos fica indisponível.',
  }

  if (lic.state === 'expiring') return {
    tone: 'amber',
    title: `A licença vence em ${dias} ${plural}.`,
    body: 'Renove antes do vencimento e nada muda. Se vencer, o painel e a coleta seguem funcionando — só o cadastro de servidores novos fica suspenso.',
  }

  if (lic.state === 'missing') {
    if (dias > 0) return {
      tone: 'amber',
      title: `Instalação em cortesia — ${dias} ${plural} restante${dias === 1 ? '' : 's'}.`,
      body: `Sem licença configurada, o painel monitora ${lic.max_servers} servidor. Ao fim da cortesia o monitoramento continua; só o cadastro de servidores novos fica suspenso.`,
    }
    return {
      tone: 'red',
      title: 'O período de cortesia terminou.',
      body: 'Os servidores já cadastrados seguem sendo monitorados normalmente. Para adicionar servidores, configure a licença (MAILIQ_LICENSE) no .env do painel.',
    }
  }

  return null
}

export default function LicenseBanner() {
  const { license } = useLicense()
  const { search, pathname } = useLocation()

  if (!license || license.state === 'ok') return null

  const info = describe(license)
  if (!info) return null

  const { bg, border, fg, Icon } = TONE[info.tone]
  const onLicensePage = pathname.startsWith('/settings') && !pathname.includes('/settings/')

  return (
    <div
      role="status"
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '9px 20px', background: bg,
        borderBottom: `1px solid ${border}`, flexShrink: 0,
      }}
    >
      <Icon size={15} color={fg} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ minWidth: 0, fontSize: 12, lineHeight: 1.5 }}>
        <span style={{ color: fg, fontWeight: 700 }}>{info.title}</span>{' '}
        <span style={{ color: 'var(--muted)' }}>{info.body}</span>
        {!onLicensePage && (
          <>
            {' '}
            <Link
              to={`/settings${search}`}
              style={{ color: fg, fontWeight: 600, textDecoration: 'underline', whiteSpace: 'nowrap' }}
            >
              Ver detalhes
            </Link>
          </>
        )}
      </div>
    </div>
  )
}
