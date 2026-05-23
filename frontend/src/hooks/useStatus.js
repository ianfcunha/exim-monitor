/**
 * Hooks de polling para dados de status.
 *
 * useQuickStatus()  — atualiza a cada 30s (heartbeat)
 * useFullStatus()   — atualiza a cada 5min (diagnóstico completo)
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchFullStatus, fetchQuickStatus } from '../api/client'

function usePolling(fetcher, intervalMs) {
  const [data, setData]       = useState(null)
  const [error, setError]     = useState(null)
  const [loading, setLoading] = useState(true)
  const timerRef              = useRef(null)

  const fetch = useCallback(async () => {
    try {
      const result = await fetcher()
      setData(result)
      setError(null)
    } catch (err) {
      setError(err?.response?.data?.detail || err.message || 'Erro desconhecido')
    } finally {
      setLoading(false)
    }
  }, [fetcher])

  useEffect(() => {
    fetch()
    timerRef.current = setInterval(fetch, intervalMs)
    return () => clearInterval(timerRef.current)
  }, [fetch, intervalMs])

  return { data, error, loading, refresh: fetch }
}

export function useQuickStatus() {
  return usePolling(fetchQuickStatus, 30_000)
}

export function useFullStatus() {
  return usePolling(fetchFullStatus, 5 * 60_000)
}
