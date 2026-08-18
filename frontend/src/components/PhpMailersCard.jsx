/**
 * PhpMailersCard — resultado de analyze_php_mailers_json() (script),
 * incluído no --json completo. Varre /srv, /var/www e, desde a última
 * sessão, /home/<usuario>/public_html (padrão cPanel/WHM) atrás de
 * scripts PHP com padrões de ofuscação/mailer malicioso.
 *
 * Puramente informativo — não dispara nada, só mostra o que o ciclo
 * completo (a cada 5min) já coletou.
 */
import { Bug, ShieldCheck } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export default function PhpMailersCard({ phpMailers, loading }) {
  const suspicious = phpMailers?.suspicious ?? 0
  const mailCalls   = phpMailers?.mail_calls ?? 0
  const topSuspect   = phpMailers?.top_suspect ?? ''
  const hasSuspects   = suspicious > 0

  return (
    <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <div style={{
        width: 38, height: 38, borderRadius: 10, flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: hasSuspects ? 'rgba(220,38,38,0.10)' : 'rgba(22,163,74,0.10)',
        border: `1px solid ${hasSuspects ? 'rgba(220,38,38,0.18)' : 'rgba(22,163,74,0.18)'}`,
      }}>
        {hasSuspects
          ? <Bug size={17} color="#DC2626" />
          : <ShieldCheck size={17} color="#16A34A" />
        }
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span className="section-label" style={{ color: hasSuspects ? '#DC2626' : undefined }}>
            Scripts PHP maliciosos
          </span>
          {loading && <span style={{ fontSize: 10, color: '#94A3B8' }}>atualizando…</span>}
        </div>

        {hasSuspects ? (
          <div style={{ marginTop: 4, fontSize: 12.5, color: '#0F172A' }}>
            <b>{suspicious}</b> arquivo{suspicious > 1 ? 's' : ''} com padrão de ofuscação/execução dinâmica
            {mailCalls > 0 && <> · {mailCalls} usando <code style={{ fontFamily: 'monospace', fontSize: 11 }}>mail()</code></>}
            {topSuspect && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div style={{
                    marginTop: 4, fontSize: 11, color: '#991B1B', fontFamily: 'monospace',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 480,
                  }}>
                    {topSuspect}
                  </div>
                </TooltipTrigger>
                <TooltipContent className="max-w-[420px] whitespace-normal break-all">{topSuspect}</TooltipContent>
              </Tooltip>
            )}
          </div>
        ) : (
          <div style={{ marginTop: 4, fontSize: 12.5, color: '#64748B' }}>
            Nenhum script suspeito encontrado em /srv, /var/www ou contas cPanel
            {mailCalls > 0 && <> · {mailCalls} arquivo{mailCalls > 1 ? 's' : ''} usando <code style={{ fontFamily: 'monospace', fontSize: 11 }}>mail()</code> (uso legítimo)</>}
          </div>
        )}
      </div>
    </div>
  )
}
