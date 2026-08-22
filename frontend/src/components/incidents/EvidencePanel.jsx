/**
 * Sessão 2, Tarefa 6 — painel de evidência. "É ele que faz um sysadmin
 * sênior confiar em vez de tratar o produto como caixa-preta. Não é
 * enfeite — é o item mais importante da tela" (instrução explícita) —
 * por isso fica sempre visível ao lado do detalhe, nunca atrás de um
 * clique/aba extra, e nunca colapsado por padrão.
 *
 * `incident.evidence` vem de incident_engine.py::_fetch_evidence() —
 * até 10 linhas reais do mainlog que sustentam o diagnóstico deste
 * incidente especificamente (filtradas pelo evidence_hint do detector).
 */
export default function EvidencePanel({ incident }) {
  const lines = incident?.evidence?.lines ?? []

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '12px 14px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
      }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>Evidência</span>
        <span style={{ fontSize: 10, color: 'var(--dim)' }}>
          {lines.length > 0 ? `${lines.length} linha${lines.length === 1 ? '' : 's'} do mainlog` : 'sem linhas'}
        </span>
      </div>

      {!incident ? (
        <div style={{ padding: 14, fontSize: 12, color: 'var(--dim)' }}>
          Selecione um incidente para ver as linhas de log que provam o diagnóstico.
        </div>
      ) : lines.length === 0 ? (
        <div style={{ padding: 14, fontSize: 12, color: 'var(--dim)' }}>
          Nenhuma linha de evidência foi capturada para este incidente (log pode ter rotacionado).
        </div>
      ) : (
        <div style={{ flex: 1, overflow: 'auto', padding: '8px 0' }}>
          {lines.map((line, i) => (
            <div
              key={i}
              style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 10.5, lineHeight: 1.6, color: 'var(--muted)',
                padding: '3px 14px', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                borderLeft: '2px solid transparent',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface)'; e.currentTarget.style.borderLeftColor = 'var(--sky)' }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderLeftColor = 'transparent' }}
            >
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
