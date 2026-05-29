/**
 * ServerContext — gerencia a lista de servidores do usuário e o servidor ativo.
 *
 * Fornece:
 *   servers        → array de servidores do usuário
 *   activeServer   → servidor selecionado atualmente
 *   setActiveServer→ função para trocar o servidor ativo
 *   loading        → true enquanto carrega a lista inicial
 *   refresh        → recarrega a lista de servidores
 */
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { fetchServers } from '../api/client'

const ServerContext = createContext(null)

export function ServerProvider({ children }) {
  const [servers, setServers]           = useState([])
  const [activeServer, setActiveServer] = useState(null)
  const [loading, setLoading]           = useState(true)

  const refresh = useCallback(async () => {
    try {
      const list = await fetchServers()
      setServers(list)

      // Mantém o servidor ativo se ainda existir na lista
      setActiveServer(prev => {
        if (!prev) return list[0] ?? null
        const still = list.find(s => s.id === prev.id)
        return still ?? list[0] ?? null
      })
    } catch {
      setServers([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return (
    <ServerContext.Provider value={{ servers, activeServer, setActiveServer, loading, refresh }}>
      {children}
    </ServerContext.Provider>
  )
}

export function useServer() {
  const ctx = useContext(ServerContext)
  if (!ctx) throw new Error('useServer deve ser usado dentro de <ServerProvider>')
  return ctx
}
