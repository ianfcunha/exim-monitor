/**
 * DiagnosticPackageCard — "Pacote de diagnóstico" em Configurações →
 * Manutenção.
 *
 * O chamado de suporte típico gasta três mensagens só para descobrir
 * versão, estado do coletor e se o canal de alerta estava configurado.
 * Este botão resolve isso num arquivo.
 *
 * Mora na página de Manutenção, mas FORA do bloco "Zona de risco": gerar
 * um diagnóstico não altera nada no servidor nem no painel. Herdar o
 * enquadramento de perigo faria o cliente hesitar justamente na ação que
 * a gente quer que ele faça antes de abrir chamado.
 *
 * O botão "Ver o conteúdo" não é enfeite. O arquivo sai da máquina do
 * cliente e chega em nós; dizer "confie, não tem nada demais aí" não é
 * resposta. A prévia mostra exatamente o mesmo JSON que o download.
 */
import { Check, Copy, Download, FileSearch, Loader2, ShieldCheck, X } from 'lucide-react'
import { useState } from 'react'
import { downloadDiagnosticPackage, fetchDiagnosticPreview } from '../api/client'
import { useToast } from '../contexts/ToastContext'

const CONTEM = [
  'Versão do painel, do schema e do build em execução',
  'Estado do coletor e do watchdog (últimos ciclos, religamentos)',
  'Estado da licença, dos servidores cadastrados e das checagens',
  'Quais canais de alerta estão ligados e completos — sem as credenciais',
  'Incidentes recentes com as linhas de log que os provam',
]

export default function DiagnosticPackageCard() {
  const toast = useToast()
  const [baixando, setBaixando] = useState(false)
  const [previa, setPrevia] = useState(null)
  const [carregandoPrevia, setCarregandoPrevia] = useState(false)
  const [copiado, setCopiado] = useState(false)

  const baixar = async () => {
    setBaixando(true)
    try {
      const res = await downloadDiagnosticPackage()
      // Nome vindo do backend (leva o domínio do painel e o carimbo de
      // hora) — dois pacotes de clientes diferentes na mesma caixa de
      // entrada precisam ser distinguíveis sem abrir os dois.
      const cd = res.headers?.['content-disposition'] || ''
      const nome = /filename="([^"]+)"/.exec(cd)?.[1] || 'mailiq-diagnostico.json'
      const url = URL.createObjectURL(res.data)
      const a = document.createElement('a')
      a.href = url
      a.download = nome
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      toast({ type: 'ok', msg: `${nome} baixado. Anexe no chamado.` })
    } catch (err) {
      toast({ type: 'err', msg: err?.response?.data?.detail || err.message || 'Erro ao gerar o pacote.' })
    } finally {
      setBaixando(false)
    }
  }

  const verConteudo = async () => {
    setCarregandoPrevia(true)
    try {
      setPrevia(await fetchDiagnosticPreview())
    } catch (err) {
      toast({ type: 'err', msg: err?.response?.data?.detail || err.message || 'Erro ao carregar a prévia.' })
    } finally {
      setCarregandoPrevia(false)
    }
  }

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(previa)
      setCopiado(true)
      setTimeout(() => setCopiado(false), 2000)
    } catch {
      toast({ type: 'err', msg: 'O navegador não permitiu copiar. Use o download.' })
    }
  }

  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
      padding: '20px 20px 16px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
    }}>
      <p style={{ fontSize: 10, letterSpacing: '0.30em', textTransform: 'uppercase', color: 'var(--sky)', fontWeight: 700, margin: '0 0 6px' }}>
        Pacote de diagnóstico
      </p>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 14px', lineHeight: 1.55 }}>
        Um arquivo com o estado do painel para anexar ao abrir um chamado.
        Gerar não altera nada — nem no painel, nem nos servidores monitorados.
      </p>

      <div style={{ display: 'grid', gap: 14, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', marginBottom: 16 }}>
        <div>
          <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)', margin: '0 0 6px' }}>O que vai dentro</p>
          <ul style={{ margin: 0, paddingLeft: 18, listStyle: 'disc', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.65 }}>
            {CONTEM.map(t => <li key={t}>{t}</li>)}
          </ul>
        </div>
        <div>
          <p style={{ fontSize: 11, fontWeight: 700, color: 'var(--ok)', margin: '0 0 6px', display: 'flex', alignItems: 'center', gap: 5 }}>
            <ShieldCheck size={13} /> O que nunca vai
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, listStyle: 'disc', fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.65 }}>
            <li>Senhas, chaves de criptografia e tokens — nem do painel, nem dos canais de alerta</li>
            <li>As credenciais SSH dos servidores monitorados, nem cifradas</li>
            <li>
              A identidade de quem enviou ou recebeu e-mail: as partes locais dos
              endereços viram <code style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>conta#a1b2c3</code>.
              O domínio fica, porque é ele que explica o problema de entrega.
            </li>
          </ul>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          onClick={baixar} disabled={baixando}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 8,
            fontSize: 12, fontWeight: 700, border: 'none', background: 'var(--sky)', color: '#fff',
            cursor: baixando ? 'progress' : 'pointer', opacity: baixando ? 0.7 : 1,
          }}>
          {baixando ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
          Baixar pacote
        </button>
        <button
          onClick={verConteudo} disabled={carregandoPrevia}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', borderRadius: 8,
            fontSize: 12, fontWeight: 600, border: '1px solid var(--border)',
            background: 'var(--surface)', color: 'var(--text)', cursor: 'pointer',
          }}>
          {carregandoPrevia ? <Loader2 size={13} className="animate-spin" /> : <FileSearch size={13} />}
          Ver o conteúdo antes
        </button>
      </div>

      {previa !== null && (
        <div style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
            padding: '8px 12px', background: 'var(--surface)', borderBottom: '1px solid var(--border)',
          }}>
            <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              Conteúdo exato do arquivo ({(previa.length / 1024).toFixed(0)} KB)
            </span>
            <span style={{ display: 'flex', gap: 6 }}>
              <button onClick={copiar}
                style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--muted)', cursor: 'pointer' }}>
                {copiado ? <Check size={12} color="var(--ok)" /> : <Copy size={12} />}
                {copiado ? 'Copiado' : 'Copiar'}
              </button>
              <button onClick={() => setPrevia(null)}
                style={{ display: 'flex', alignItems: 'center', padding: 4, borderRadius: 6, border: 'none', background: 'none', color: 'var(--dim)', cursor: 'pointer' }}>
                <X size={14} />
              </button>
            </span>
          </div>
          <pre style={{
            margin: 0, padding: 12, maxHeight: 340, overflow: 'auto',
            fontFamily: "'JetBrains Mono', monospace", fontSize: 11, lineHeight: 1.5,
            color: 'var(--text)', background: 'var(--card)', whiteSpace: 'pre',
          }}>{previa}</pre>
        </div>
      )}
    </div>
  )
}
