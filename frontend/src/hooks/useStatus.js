/**
 * Hooks de polling para dados de status.
 *
 * useQuickStatus()  — atualiza a cada 30s (heartbeat)
 * useFullStatus()   — atualiza a cada 5min (diagnóstico completo)
 *
 * Ambos passam automaticamente o server_id do servidor ativo no ServerContext.
 * Quando o servidor ativo muda, reinicia o polling automaticamente.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchFullStatus, fetchQuickStatus } from '../api/client'
import { useServer } from '../contexts/ServerContext'

function usePolling(fetcherFn, intervalMs) {
  const { activeServer, servers } = useServer()
  const serverId = activeServer?.id ?? null

  // Sessão 5: estes dados são sempre de UM servidor. Sem servidor ativo
  // e com mais de um cadastrado, o pedido era ambíguo — o backend caía
  // no primeiro da lista e a tela exibia números de um servidor que não
  // nomeava. O backend agora recusa a ambiguidade (400); aqui nem
  // chegamos a pedir, para a tela poder mostrar a escolha em vez de um
  // erro.
  const ambiguous = serverId === null && servers.length > 1

  const [data, setData]       = useState(null)
  const [error, setError]     = useState(null)
  const [loading, setLoading] = useState(true)
  const timerRef              = useRef(null)

  const fetcher = useCallback(async () => {
    if (ambiguous) { setData(null); setError(null); setLoading(false); return }
    try {
      const result = await fetcherFn(serverId)
      setData(result)
      setError(null)
    } catch (err) {
      setError(err?.response?.data?.detail || err.message || 'Erro desconhecido')
    } finally {
      setLoading(false)
    }
  }, [fetcherFn, serverId, ambiguous])

  // Reinicia polling quando servidor ativo ou fetcher muda
  useEffect(() => {
    setLoading(true)
    setData(null)
    setError(null)
    fetcher()
    clearInterval(timerRef.current)
    if (!ambiguous) timerRef.current = setInterval(fetcher, intervalMs)
    return () => clearInterval(timerRef.current)
  }, [fetcher, intervalMs, ambiguous])

  return { data, error, loading, refresh: fetcher }
}

export function useQuickStatus() {
  return usePolling(fetchQuickStatus, 30_000)
}

export function useFullStatus() {
  return usePolling(fetchFullStatus, 5 * 60_000)
}
