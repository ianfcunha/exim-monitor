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
      const retryAfter = err.response?.headers?.['retry-after']
      const msg = retryAfter
        ? `Muitas requisições. Aguarde ${retryAfter}s antes de tentar novamente.`
        : 'Muitas requisições. Aguarde um momento antes de tentar novamente.'
      window.dispatchEvent(new CustomEvent('api:rate-limited', { detail: { msg } }))
    }

    return Promise.reject(err)
  }
)

// ── Auth ──────────────────────────────────────────────────────────────────
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

export const fetchMe = () => api.get('/auth/me').then(r => r.data)

// ── Status (com server_id) ─────────────────────────────────────────────────
export const fetchQuickStatus = (serverId = null) =>
  api.get('/status/quick', { params: serverId ? { server_id: serverId } : {} }).then(r => r.data)

export const fetchFullStatus = (serverId = null) =>
  api.get('/status/full', { params: serverId ? { server_id: serverId } : {} }).then(r => r.data)

export const refreshStatus = (serverId = null) =>
  api.post('/status/refresh', null, { params: serverId ? { server_id: serverId } : {} }).then(r => r.data)

// ── Acoes (com server_id) ──────────────────────────────────────────────────
export const runAction = (action, param = null, serverId = null) =>
  api.post(
    `/actions/${action}`,
    { param },
    { params: serverId ? { server_id: serverId } : {} }
  ).then(r => r.data)

// ── Historico de acoes (auditoria) ──────────────────────────────────────────
export const fetchActionHistory = (serverId = null, limit = 100) =>
  api.get('/actions/history', { params: { limit, ...(serverId ? { server_id: serverId } : {}) } }).then(r => r.data)

// ── Historico (com server_id) ──────────────────────────────────────────────
export const fetchHistory = (hours = 24, mode = 'quick', serverId = null) =>
  api.get('/history', { params: { hours, mode, ...(serverId ? { server_id: serverId } : {}) } }).then(r => r.data)

export const fetchSummary = (serverId = null) =>
  api.get('/history/summary', { params: serverId ? { server_id: serverId } : {} }).then(r => r.data)

// ── Mensagens (fila + log, com server_id) ─────────────────────────────────
export const fetchQueueMessages = (serverId = null) =>
  api.get('/messages/queue', { params: serverId ? { server_id: serverId } : {} }).then(r => r.data)

export const fetchLogMessages = (type, limit = 100, serverId = null) =>
  api.get('/messages/log', { params: { type, limit, ...(serverId ? { server_id: serverId } : {}) } }).then(r => r.data)

export const fetchLogTail = (limit = 300, serverId = null) =>
  api.get('/messages/tail', { params: { limit, ...(serverId ? { server_id: serverId } : {}) } }).then(r => r.data)

// Retorna a resposta completa (não só .data) — quem chama precisa do
// header Content-Disposition (nome do arquivo) e do blob para disparar
// o download no navegador.
export const exportLogMessages = (params, serverId = null) =>
  api.get('/messages/export', {
    params: { ...params, ...(serverId ? { server_id: serverId } : {}) },
    responseType: 'blob',
  })

// ── Servidores ────────────────────────────────────────────────────────────
export const fetchServers      = () => api.get('/servers').then(r => r.data)
export const createServer      = (payload) => api.post('/servers', payload).then(r => r.data)
export const updateServer      = (id, payload) => api.put(`/servers/${id}`, payload).then(r => r.data)
export const deleteServer      = (id) => api.delete(`/servers/${id}`).then(r => r.data)
export const testServerConn    = (id) => api.post(`/servers/${id}/test`).then(r => r.data)
export const fetchServerSshStatus = (id) => api.get(`/servers/${id}/ssh-status`).then(r => r.data)

// ── Usuários ──────────────────────────────────────────────────────────────
export const fetchUsers     = () => api.get('/users').then(r => r.data)
export const inviteUser     = (payload) => api.post('/users/invite', payload).then(r => r.data)
export const updateUserRole = (id, role) => api.patch(`/users/${id}/role`, { role }).then(r => r.data)
export const deleteUser     = (id) => api.delete(`/users/${id}`).then(r => r.data)
export const checkInvite    = (token) => api.get(`/users/accept/${token}`).then(r => r.data)
export const acceptInvite   = (token, payload) => api.post(`/users/accept/${token}`, payload).then(r => r.data)
export const resendInvite   = (id) => api.post(`/users/${id}/resend-invite`).then(r => r.data)
export const getInviteLink  = (id) => api.get(`/users/${id}/invite-link`).then(r => r.data)

// ── Configuracoes de alertas ──────────────────────────────────────────────
export const fetchAlertHistory  = (limit = 50) =>
  api.get('/settings/alerts/history', { params: { limit } }).then(r => r.data)
export const fetchAlertSettings = (serverId = null) =>
  api.get('/settings/alerts', { params: serverId ? { server_id: serverId } : {} }).then(r => r.data)
export const saveAlertSettings  = (payload, serverId = null) =>
  api.put('/settings/alerts', payload, { params: serverId ? { server_id: serverId } : {} }).then(r => r.data)
export const testEmail          = (serverId = null) =>
  api.post('/settings/test/email', null, { params: serverId ? { server_id: serverId } : {} }).then(r => r.data)
export const testTelegram       = (serverId = null) =>
  api.post('/settings/test/telegram', null, { params: serverId ? { server_id: serverId } : {} }).then(r => r.data)
export const testWeeklyReport   = (serverId = null) =>
  api.post('/settings/test/weekly-report', null, { params: serverId ? { server_id: serverId } : {} }).then(r => r.data)

export default api
