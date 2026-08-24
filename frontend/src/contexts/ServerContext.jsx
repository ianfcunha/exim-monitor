/**
 * ServerContext — lista de servidores do usuário e o servidor ativo.
 *
 * Sessão 4, Tarefa 8: o servidor selecionado é ESTADO GLOBAL refletido
 * na URL (`?server=8` ou `?server=all`), não um useState que cada tela
 * reinicializa por conta própria.
 *
 * O defeito que isto corrige: o contexto de servidor não viajava entre
 * telas — a tela de Alertas abria configurando "Cloudez LAB" enquanto o
 * dashboard estava em "Tyna Host LAB". Duas telas, dois servidores
 * ativos, nenhum aviso. Com a seleção na URL, navegar preserva o
 * contexto, o botão "voltar" do navegador funciona, e um link colado no
 * chat abre no mesmo servidor de quem mandou.
 *
 * `activeServer` é null quando o escopo é a frota inteira — telas que
 * exigem um servidor mostram um seletor em vez de escolher um sozinhas.
 *
 * Fornece:
 *   servers        → array de servidores do usuário
 *   activeServer   → servidor selecionado, ou null em "Toda a frota"
 *   isFleet        → true quando o escopo é a frota inteira
 *   setActiveServer→ troca o servidor ativo (passe null para a frota)
 *   loading        → true enquanto carrega a lista inicial
 *   refresh        → recarrega a lista de servidores
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { fetchServers } from '../api/client'

const ServerContext = createContext(null)

export const FLEET = 'all'
const STORAGE_KEY = 'exim_active_server'

export function ServerProvider({ children }) {
  const [servers, setServers] = useState([])
  const [loading, setLoading] = useState(true)
  const [searchParams, setSearchParams] = useSearchParams()

  const param = searchParams.get('server')

  const refresh = useCallback(async () => {
    try {
      setServers(await fetchServers())
    } catch {
      setServers([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Trocar de servidor EMPILHA no histórico (sem `replace`) — é uma
  // navegação deliberada, e o "voltar" do navegador tem que desfazê-la.
  // Com `replace: true` a entrada anterior era sobrescrita: voltar
  // pulava a troca inteira e o usuário aterrissava numa tela sem
  // relação com o que acabou de fazer.
  const setActiveServer = useCallback((server) => {
    const value = server ? String(server.id) : FLEET
    localStorage.setItem(STORAGE_KEY, value)
    // Re-selecionar o que já está ativo não é navegação — não empilha.
    if (value === param) return
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('server', value)
      return next
    })
  }, [setSearchParams, param])

  // Sem `?server` na URL (primeira visita, ou link sem o parâmetro):
  // usa a última escolha guardada e a grava na URL — daí em diante a URL
  // é a única fonte da verdade.
  useEffect(() => {
    if (param || loading) return
    const remembered = localStorage.getItem(STORAGE_KEY)
    const valid = remembered === FLEET || servers.some(s => String(s.id) === remembered)
    const fallback = servers.length > 1 ? FLEET : String(servers[0]?.id ?? FLEET)
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('server', valid ? remembered : fallback)
      return next
    }, { replace: true })
  }, [param, loading, servers, setSearchParams])

  const activeServer = useMemo(() => {
    if (!param || param === FLEET) return null
    return servers.find(s => String(s.id) === param) ?? null
  }, [param, servers])

  const isFleet = !param || param === FLEET

  return (
    <ServerContext.Provider
      value={{ servers, activeServer, isFleet, setActiveServer, loading, refresh }}
    >
      {children}
    </ServerContext.Provider>
  )
}

export function useServer() {
  const ctx = useContext(ServerContext)
  if (!ctx) throw new Error('useServer deve ser usado dentro de <ServerProvider>')
  return ctx
}
