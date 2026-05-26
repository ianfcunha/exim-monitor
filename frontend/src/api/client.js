/**
 * Cliente Axios pre-configurado.
 * Injeta Bearer token em toda requisicao autenticada.
 * - 401: limpa token e forca reload (volta ao login)
 * - 429: Too Many Requests — dispara evento global para exibir toast
 */
import axios from 'axios'

const api = axios.create({
  baseURL: '/api',
  timeout: 30_000,
})

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('exim_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  (res) => res,
  (err) => {
    const status = err.response?.status

    if (status === 401) {
      localStorage.removeItem('exim_token')
      window.location.reload()
    }

    if (status === 429) {
      // Dispara evento customizado — capturado pelo ToastProvider em App.jsx
      const retryAfter = err.response?.headers?.['retry-after']
      const msg = retryAfter
        ? `Muitas requisições. Aguarde ${retryAfter}s antes de tentar novamente.`
        : 'Muitas requisições. Aguarde um momento antes de tentar novamente.'
      window.dispatchEvent(new CustomEvent('api:rate-limited', { detail: { msg } }))
    }

    return Promise.reject(err)
  }
)

// ── Status ────────────────────────────────────────────────────────────────
export const fetchQuickStatus = () => api.get('/status/quick').then(r => r.data)
export const fetchFullStatus  = () => api.get('/status/full').then(r => r.data)
export const refreshStatus    = () => api.post('/status/refresh').then(r => r.data)

// ── Acoes ─────────────────────────────────────────────────────────────────
export const runAction = (action, param = null) =>
  api.post(`/actions/${action}`, { param }).then(r => r.data)

// ── Historico ─────────────────────────────────────────────────────────────
export const fetchHistory = (hours = 24, mode = 'quick') =>
  api.get('/history', { params: { hours, mode } }).then(r => r.data)
export const fetchSummary = () => api.get('/history/summary').then(r => r.data)

// ── Autenticacao ──────────────────────────────────────────────────────────
export const login = (username, password) => {
  const form = new URLSearchParams()
  form.append('username', username)
  form.append('password', password)
  return api
    .post('/auth/login', form, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    .then(r => r.data)
}

// ── Mensagens (fila + log) ────────────────────────────────────────────────
export const fetchQueueMessages = () =>
  api.get('/messages/queue').then(r => r.data)

export const fetchLogMessages = (type, limit = 100) =>
  api.get('/messages/log', { params: { type, limit } }).then(r => r.data)

export const fetchLogTail = (limit = 300) =>
  api.get('/messages/tail', { params: { limit } }).then(r => r.data)

// ── Configuracoes de alertas ──────────────────────────────────────────────
export const fetchAlertHistory = (limit = 50) =>
  api.get('/settings/alerts/history', { params: { limit } }).then(r => r.data)

export const fetchAlertSettings = () =>
  api.get('/settings/alerts').then(r => r.data)

export const saveAlertSettings = (payload) =>
  api.put('/settings/alerts', payload).then(r => r.data)

export const testEmail    = () => api.post('/settings/test/email').then(r => r.data)
export const testTelegram = () => api.post('/settings/test/telegram').then(r => r.data)

export default api
