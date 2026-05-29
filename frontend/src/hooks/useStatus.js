/**
 * Hooks de polling para dados de status.
 *
 * useQuickStatus()  — atualiza a cada 30s (heartbeat)
 * useFullStatus()   — atualiza a cada 5min (diagnóstico completo)
 *
 * Ambos passam automaticamente o server_id do ServerContext ativo.
 * Quando não há ServerContext disponível (ex: durante migração), usa null.
 */
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { fetchFullStatus, fetchQuickStatus } from '../api/client'

// Import lazy para evitar erro circular se ServerContext não estiver montado ainda
let _ServerContext = null
function getServerContext() {
  if (!_ServerContext) {
    try {
      _ServerContext = require('../contexts/ServerContext').default
    } catch {
      return null
    }
  }
  return _ServerContext
}

function useActiveServerId() {
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const { useServer } = require('../contexts/ServerContext')
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const { activeServer } = useServer()
    return activeServer?.id ?? null
  } catch {
    return null
  }
}

function usePolling(fetcherFn, intervalMs) {
  const [data, setData]       = useState(null)
  const [error, setError]     = useState(null)
  const [loading, setLoading] = useState(true)
  const timerRef              = useRef(null)
  const serverIdRef           = useRef(null)

  // Tenta usar o server_id do contexto
  let serverId = null
  try {
    const { useServer } = require('../contexts/ServerContext')
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const { activeServer } = useServer()
    serverId = activeServer?.id ?? null
  } catch {
    serverId = null
  }

  const fetcher = useCallback(async () => {
    try {
      const result = await fetcherFn(serverIdRef.current)
      setData(result)
      setError(null)
    } catch (err) {
      setError(err?.response?.data?.detail || err.message || 'Erro desconhecido')
    } finally {
      setLoading(false)
    }
  }, [fetcherFn])

  // Atualiza ref sem recriar o fetcher
  useEffect(() => {
    serverIdRef.current = serverId
  }, [serverId])

  // Reinicia o polling quando o servidor ativo muda
  useEffect(() => {
    setLoading(true)
    setData(null)
    setError(null)
    fetcher()
    clearInterval(timerRef.current)
    timerRef.current = setInterval(fetcher, intervalMs)
    return () => clearInterval(timerRef.current)
  }, [fetcher, intervalMs, serverId])

  return { data, error, loading, refresh: fetcher }
}

export function useQuickStatus() {
  return usePolling(fetchQuickStatus, 30_000)
}

export function useFullStatus() {
  return usePolling(fetchFullStatus, 5 * 60_000)
}
