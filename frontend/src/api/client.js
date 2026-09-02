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

// Sessão 4, T5 — fonte única do estado de saúde. Devolve exatamente o
// mesmo objeto de /incidents/summary?server_id=N (ambos chamam
// health.py no backend); é o que impede a Triagem e o painel clássico
// de mostrarem selos diferentes para o mesmo servidor no mesmo instante.
export const fetchServerHealth = (serverId = null) =>
  api.get('/status/health', { params: serverId ? { server_id: serverId } : {} }).then(r => r.data)

// ── Acoes (com server_id) ──────────────────────────────────────────────────
// T3 (Sessão 1, pós-auditoria): toda ação destrutiva agora é plan() depois
// apply() — planAction() não altera nada no servidor, só retorna um
// plan_id (válido 5min) + preview do que aconteceria. runAction() exige
// esse plan_id pra qualquer ação fora de check-deliverability.
export const planAction = (action, param = null, serverId = null) =>
  api.post(
    `/actions/${action}/plan`,
    { param },
    { params: serverId ? { server_id: serverId } : {} }
  ).then(r => r.data)

export const runAction = (action, param = null, serverId = null, snapshot = true, planId = null) =>
  api.post(
    `/actions/${action}`,
    { param, snapshot, plan_id: planId },
    { params: serverId ? { server_id: serverId } : {} }
  ).then(r => r.data)

// ── Quarentena de mensagens (T3) ────────────────────────────────────────────
export const fetchQuarantine = (serverId = null) =>
  api.get('/actions/quarantine', { params: serverId ? { server_id: serverId } : {} }).then(r => r.data)

export const restoreQuarantine = (incident, serverId = null) =>
  api.post(`/actions/quarantine/${incident}/restore`, null, { params: serverId ? { server_id: serverId } : {} }).then(r => r.data)

// ── Historico de acoes (auditoria) ──────────────────────────────────────────
export const fetchActionHistory = (serverId = null, limit = 100) =>
  api.get('/actions/history', { params: { limit, ...(serverId ? { server_id: serverId } : {}) } }).then(r => r.data)

// T8 (Sessão 1, pós-auditoria): exportação por período/servidor.
export const exportActionHistory = (params, serverId = null) =>
  api.get('/actions/history/export', {
    params: { ...params, ...(serverId ? { server_id: serverId } : {}) },
    responseType: 'blob',
  })

// ── Historico (com server_id) ──────────────────────────────────────────────
// A barra no fim é proposital: a rota no backend é "/api/history/" (o
// router monta GET "/" sob o prefixo "/api/history"). Sem a barra, o
// FastAPI responde 307 pra a forma com barra — atrás do proxy real esse
// redirect sai como "http://" (sem TLS), e o navegador bloqueia como
// conteúdo misto numa página https, silenciosamente (a chamada falha,
// cai no .catch(), a tela só mostra "sem dados"). Chamando a URL final
// direto, o redirect nunca acontece.
export const fetchHistory = (hours = 24, mode = 'quick', serverId = null) =>
  api.get('/history/', { params: { hours, mode, ...(serverId ? { server_id: serverId } : {}) } }).then(r => r.data)

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
export const fetchAlertHistory  = (limit = 50, serverId = null) =>
  api.get('/settings/alerts/history', { params: { limit, ...(serverId ? { server_id: serverId } : {}) } }).then(r => r.data)
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
export const testMonthlyReport  = (serverId = null) =>
  api.post('/settings/test/monthly-report', null, { params: serverId ? { server_id: serverId } : {} }).then(r => r.data)
export const testWebhook        = (serverId = null) =>
  api.post('/settings/test/webhook', null, { params: serverId ? { server_id: serverId } : {} }).then(r => r.data)

// ── Incidentes (Sessão 2) ──────────────────────────────────────────────────
// Sem server_id: cross-fleet por padrão (a Triagem lista todos os
// servidores juntos) — mesma convenção "sem filtro = tudo que o usuário
// vê" do resto da API (ex.: fetchActionHistory).
export const fetchIncidents = (params = {}) =>
  api.get('/incidents', { params }).then(r => r.data)

export const fetchIncidentsSummary = (serverId = null) =>
  api.get('/incidents/summary', { params: serverId ? { server_id: serverId } : {} }).then(r => r.data)

export const fetchIncident = (id) =>
  api.get(`/incidents/${id}`).then(r => r.data)

export const ackIncident = (id) =>
  api.post(`/incidents/${id}/ack`).then(r => r.data)

export const silenceIncident = (id, minutes = 60) =>
  api.post(`/incidents/${id}/silence`, { minutes }).then(r => r.data)

export const resolveIncident = (id, resolution = 'manual') =>
  api.post(`/incidents/${id}/resolve`, { resolution }).then(r => r.data)

// plan()/apply() — mesmo fluxo de duas fases da Sessão 1 (ver
// planAction/runAction acima), aplicado à correção sugerida do
// incidente em vez de uma ação escolhida manualmente no ActionPanel.
export const planIncidentFix = (id) =>
  api.post(`/incidents/${id}/fix/plan`).then(r => r.data)

export const applyIncidentFix = (id, planId, snapshot = true) =>
  api.post(`/incidents/${id}/fix/apply`, { plan_id: planId, snapshot }).then(r => r.data)

// ── Thresholds de detector (formulário simples, não uma aba "Regras") ──────
export const fetchIncidentConfig = (serverId) =>
  api.get(`/incidents/config/${serverId}`).then(r => r.data)

export const saveIncidentConfig = (serverId, type, thresholds) =>
  api.put(`/incidents/config/${serverId}/${type}`, { thresholds }).then(r => r.data)

// ── Reputação (Sessão 3, T4) — cross-fleet por padrão ───────────────────────
export const fetchReputation = (serverId = null) =>
  api.get('/reputation', { params: serverId ? { server_id: serverId } : {} }).then(r => r.data)

// ── Relatório de incidente (Sessão 3, T2) ───────────────────────────────────
// HTML autocontido — buscado como blob (não navegação direta) porque a
// rota exige o mesmo Bearer token de toda a API; quem chama abre via
// URL.createObjectURL (nova aba) ou dispara download, mesmo padrão de
// exportLogMessages/exportActionHistory.
export const fetchIncidentReportHtml = (id) =>
  api.get(`/incidents/${id}/report`, { responseType: 'blob' })

// Sessão 4, T9 — link de leitura com validade, para encaminhar o
// relatório a quem não tem conta no painel.
export const shareIncidentReport = (id, hours = 168) =>
  api.post(`/incidents/${id}/report/share`, { hours }).then(r => r.data)

// ── Meta ───────────────────────────────────────────────────────────────────
// Versão em execução — endpoint público (sem Bearer). Usado no rodapé do
// painel e pelo upgrade.sh para confirmar o que subiu.
export const fetchVersion = () => api.get('/version').then(r => r.data)

export default api
