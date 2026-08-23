/**
 * Página de relatório de incidente — Sessão 4, Tarefa 9.
 *
 * Antes, "Ver relatório" abria um `blob:` em aba nova: sem endereço
 * permanente, sem botão voltar, impossível de compartilhar ou salvar nos
 * favoritos. Era justamente o artefato que o dono do host deveria
 * encaminhar ao cliente dele.
 *
 * Agora é uma rota real (`/incidents/{id}/report`): endereço estável,
 * link copiável, versão para impressão e — para quem não tem conta no
 * painel — um link de leitura com validade.
 *
 * O HTML do relatório continua vindo do backend (uma peça autocontida,
 * a mesma servida no link público) e é renderizado num iframe isolado,
 * para o CSS dele não vazar para o painel nem o contrário.
 */
import { ArrowLeft, Check, Copy, Link2, Printer } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { fetchIncidentReportHtml, shareIncidentReport } from '../api/client'
import { useToast } from '../contexts/ToastContext'

function CopyButton({ value, label = 'Copiar link' }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      // Sem permissão de clipboard (http sem TLS, por exemplo): seleciona
      // o texto num campo temporário para o usuário copiar à mão.
      const el = document.createElement('textarea')
      el.value = value
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      el.remove()
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <Button size="sm" variant="outline" onClick={copy}>
      {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copiado' : label}
    </Button>
  )
}

export default function IncidentReportPage() {
  const { id } = useParams()
  const toast = useToast()
  const [html, setHtml] = useState(null)
  const [error, setError] = useState(null)
  const [share, setShare] = useState(null)
  const [sharing, setSharing] = useState(false)
  const frameRef = useRef(null)

  useEffect(() => {
    let alive = true
    fetchIncidentReportHtml(id)
      .then(res => res.data.text())
      .then(text => { if (alive) setHtml(text) })
      .catch(err => {
        if (alive) setError(err?.response?.data?.detail || err.message || 'Não foi possível carregar o relatório.')
      })
    return () => { alive = false }
  }, [id])

  const print = () => {
    const frame = frameRef.current
    if (!frame?.contentWindow) return
    frame.contentWindow.focus()
    frame.contentWindow.print()
  }

  const createShareLink = async () => {
    setSharing(true)
    try {
      const res = await shareIncidentReport(id, 168)
      setShare({ url: `${window.location.origin}${res.path}`, expiresAt: res.expires_at })
    } catch (err) {
      toast({ type: 'err', msg: err?.response?.data?.detail || 'Não foi possível gerar o link de leitura.' })
    } finally {
      setSharing(false)
    }
  }

  const permalink = `${window.location.origin}/incidents/${id}/report`

  return (
    <div style={{ minHeight: '100vh', background: 'var(--surface)', display: 'flex', flexDirection: 'column' }}>
      <header className="report-toolbar" style={{
        position: 'sticky', top: 0, zIndex: 10, flexShrink: 0,
        background: 'var(--card)', borderBottom: '1px solid var(--border)',
        padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      }}>
        <Link
          to={`/triage/${id}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12,
                   color: 'var(--muted)', textDecoration: 'none' }}
        >
          <ArrowLeft size={13} /> Voltar ao incidente
        </Link>
        <span style={{ width: 1, height: 16, background: 'var(--border)' }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>
          Relatório do INC-{id}
        </span>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <CopyButton value={permalink} label="Copiar link" />
          <Button size="sm" variant="outline" onClick={print} disabled={!html}>
            <Printer size={12} /> Imprimir
          </Button>
          <Button size="sm" variant="outline" onClick={createShareLink} disabled={sharing}>
            <Link2 size={12} /> {sharing ? 'Gerando…' : 'Link para quem não tem conta'}
          </Button>
        </div>
      </header>

      {share && (
        <div style={{
          padding: '10px 20px', background: 'var(--accent-bg)',
          borderBottom: '1px solid var(--accent-border)', display: 'flex',
          alignItems: 'center', gap: 10, flexWrap: 'wrap',
        }}>
          <div style={{ fontSize: 11.5, color: 'var(--text)', minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>
              Link de leitura — abre sem login, expira em {new Date(share.expiresAt).toLocaleString('pt-BR')}
            </div>
            <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: 'var(--muted)',
                          wordBreak: 'break-all' }}>
              {share.url}
            </div>
          </div>
          <CopyButton value={share.url} label="Copiar link de leitura" />
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, padding: 16 }}>
        {error ? (
          <div style={{
            maxWidth: 700, margin: '40px auto', padding: '14px 16px', borderRadius: 10,
            background: 'var(--danger-bg)', border: '1px solid var(--danger-border)',
            color: 'var(--danger)', fontSize: 13,
          }}>
            {error}
          </div>
        ) : !html ? (
          <p style={{ fontSize: 13, color: 'var(--dim)', textAlign: 'center', marginTop: 40 }}>
            Carregando relatório…
          </p>
        ) : (
          <iframe
            ref={frameRef}
            title={`Relatório do incidente INC-${id}`}
            srcDoc={html}
            style={{
              width: '100%', height: 'calc(100vh - 120px)', border: '1px solid var(--border)',
              borderRadius: 10, background: '#fff',
            }}
          />
        )}
      </div>

      <style>{`
        @media print {
          .report-toolbar { display: none !important; }
        }
      `}</style>
    </div>
  )
}
