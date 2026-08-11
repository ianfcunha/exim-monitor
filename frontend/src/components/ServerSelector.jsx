/**
 * ServerSelector — dropdown no header para trocar o servidor ativo.
 * Aparece apenas quando o usuário tem mais de um servidor.
 *
 * O painel usa position:fixed (calculado via getBoundingClientRect) em vez
 * de position:absolute — o header tem overflow:hidden num ancestral (para
 * truncar nomes longos), o que cortava/escondia um dropdown absoluto.
 * position:fixed escapa desse clipping por renderizar relativo à viewport.
 */
import { ChevronDown, Server } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useServer } from '../contexts/ServerContext'

const STATUS_DOT = {
  ok:      '#16A34A',
  error:   '#DC2626',
  timeout: '#D97706',
  unknown: '#94A3B8',
}

export default function ServerSelector() {
  const { servers, activeServer, setActiveServer } = useServer()
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState({ top: 0, left: 0 })
  const btnRef = useRef(null)
  const panelRef = useRef(null)

  // Fecha ao clicar fora (botão OU painel — painel agora não é mais filho do botão no DOM)
  useEffect(() => {
    const handler = (e) => {
      if (
        btnRef.current && !btnRef.current.contains(e.target) &&
        panelRef.current && !panelRef.current.contains(e.target)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Recalcula a posição toda vez que o dropdown abre (e ao redimensionar/rolar)
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const update = () => {
      const r = btnRef.current.getBoundingClientRect()
      setCoords({ top: r.bottom + 6, left: r.left })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])

  if (!activeServer) return null

  return (
    <div style={{ position: 'relative' }}>
      <button
        ref={btnRef}
        onClick={() => setOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '5px 10px', borderRadius: 8, fontSize: 11, fontWeight: 500,
          border: open ? '1px solid #BAE6FD' : '1px solid #E2E8F0',
          background: open ? '#F0F9FF' : '#fff',
          color: open ? '#0369A1' : '#0F172A',
          cursor: 'pointer', transition: 'all 0.15s',
          maxWidth: 200,
        }}
      >
        <span style={{
          width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
          background: STATUS_DOT[activeServer.ssh_status] ?? '#94A3B8',
        }} />
        <Server size={11} style={{ flexShrink: 0 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {activeServer.name}
        </span>
        <ChevronDown size={11} style={{
          flexShrink: 0,
          transform: open ? 'rotate(180deg)' : 'none',
          transition: 'transform 0.15s',
        }} />
      </button>

      {open && (
        <div
          ref={panelRef}
          style={{
            position: 'fixed', top: coords.top, left: coords.left,
            background: '#fff', border: '1px solid #E2E8F0', borderRadius: 10,
            boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
            minWidth: 220, zIndex: 1000,
            overflow: 'hidden',
          }}
        >
          <div style={{ padding: '6px 0' }}>
            {servers.map(s => (
              <button
                key={s.id}
                onClick={() => { setActiveServer(s); setOpen(false) }}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 14px', fontSize: 12, textAlign: 'left',
                  background: activeServer.id === s.id ? '#F0F9FF' : 'transparent',
                  color: activeServer.id === s.id ? '#0369A1' : '#0F172A',
                  border: 'none', cursor: 'pointer',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => { if (activeServer.id !== s.id) e.currentTarget.style.background = '#F8FAFC' }}
                onMouseLeave={e => { if (activeServer.id !== s.id) e.currentTarget.style.background = 'transparent' }}
              >
                <span style={{
                  width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                  background: STATUS_DOT[s.ssh_status] ?? '#94A3B8',
                }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.name}
                  </div>
                  <div style={{ fontSize: 10, color: '#94A3B8', fontFamily: 'monospace' }}>
                    {s.host}:{s.port}
                  </div>
                </div>
                {activeServer.id === s.id && (
                  <span style={{ fontSize: 10, color: '#0369A1', fontWeight: 700 }}>●</span>
                )}
              </button>
            ))}
          </div>

          <div style={{ borderTop: '1px solid #F1F5F9', padding: '6px 8px' }}>
            <button
              onClick={() => { window.dispatchEvent(new CustomEvent('navigate', { detail: 'servers' })); setOpen(false) }}
              style={{
                width: '100%', padding: '6px 8px', borderRadius: 7,
                fontSize: 11, fontWeight: 500, border: 'none',
                background: '#F8FAFC', color: '#64748B', cursor: 'pointer',
                textAlign: 'center',
              }}
            >
              + Gerenciar servidores
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
