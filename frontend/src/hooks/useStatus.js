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
  const { activeServer } = useServer()
  const serverId = activeServer?.id ?? null

  const [data, setData]       = useState(null)
  const [error, setError]     = useState(null)
  const [loading, setLoading] = useState(true)
  const timerRef              = useRef(null)

  const fetcher = useCallback(async () => {
    try {
      const result = await fetcherFn(serverId)
      setData(result)
      setError(null)
    } catch (err) {
      setError(err?.response?.data?.detail || err.message || 'Erro desconhecido')
    } finally {
      setLoading(false)
    }
  }, [fetcherFn, serverId])

  // Reinicia polling quando servidor ativo ou fetcher muda
  useEffect(() => {
    setLoading(true)
    setData(null)
    setError(null)
    fetcher()
    clearInterval(timerRef.current)
    timerRef.current = setInterval(fetcher, intervalMs)
    return () => clearInterval(timerRef.current)
  }, [fetcher, intervalMs])

  return { data, error, loading, refresh: fetcher }
}

export function useQuickStatus() {
  return usePolling(fetchQuickStatus, 30_000)
}

export function useFullStatus() {
  return usePolling(fetchFullStatus, 5 * 60_000)
}
