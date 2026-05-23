/**
 * Cliente Axios pre-configurado.
 * Injeta Bearer token em toda requisicao autenticada.
 * Em caso de 401, limpa o token e forca recarregar a pagina (volta ao login).
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
    if (err.response?.status === 401) {
      localStorage.removeItem('exim_token')
      window.location.reload()
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

// ── Configuracoes de alertas ──────────────────────────────────────────────
export const fetchAlertSettings = () =>
  api.get('/settings/alerts').then(r => r.data)

export const saveAlertSettings = (payload) =>
  api.put('/settings/alerts', payload).then(r => r.data)

export const testEmail    = () => api.post('/settings/test/email').then(r => r.data)
export const testTelegram = () => api.post('/settings/test/telegram').then(r => r.data)

export default api
