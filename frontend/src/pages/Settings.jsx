/**
 * Configurações de alertas — renderizada dentro de SettingsLayout
 * (aba "Alertas"), sem header/wrapper de página próprio.
 */
import { RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { fetchAlertHistory, fetchAlertSettings, saveAlertSettings, testEmail, testMonthlyReport, testTelegram, testWeeklyReport, testWebhook } from '../api/client'
import { Select as SelectPrimitive, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useServer } from '../contexts/ServerContext'

const SEVERITY_OPTIONS = ['HIGH', 'CRITICAL']
const MASK = '••••••••'

const inputStyle = {
  width: '100%', borderRadius: 8,
  background: 'var(--surface)', border: '1px solid var(--border)',
  padding: '9px 13px', fontSize: 12, color: 'var(--text)', outline: 'none',
  transition: 'border-color 0.15s, box-shadow 0.15s',
}

/* ── Primitivos ── */
function Section({ title, children }) {
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
      padding: '20px 20px 16px', marginBottom: 12,
      boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
    }}>
      <p style={{ fontSize: 10, letterSpacing: '0.30em', textTransform: 'uppercase', color: 'var(--sky)', fontWeight: 700, marginBottom: 16 }}>
        {title}
      </p>
      {children}
    </div>
  )
}

function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 5 }}>
        {label}
      </label>
      {hint && <p style={{ fontSize: 11, color: 'var(--dim)', marginBottom: 6 }}>{hint}</p>}
      {children}
    </div>
  )
}

function Input({ value, onChange, type = 'text', placeholder = '' }) {
  return (
    <input
      type={type} value={value ?? ''} onChange={e => onChange(e.target.value)}
      placeholder={placeholder} style={inputStyle}
      onFocus={e => { e.target.style.borderColor = 'var(--sky)'; e.target.style.boxShadow = '0 0 0 3px rgba(14,165,233,0.15)' }}
      onBlur={e  => { e.target.style.borderColor = 'var(--border)'; e.target.style.boxShadow = 'none' }}
    />
  )
}

function Select({ value, onChange, children }) {
  return (
    <SelectPrimitive value={value ?? ''} onValueChange={onChange}>
      <SelectTrigger className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </SelectPrimitive>
  )
}

function Toggle({ checked, onChange, label }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none' }}>
      <Switch checked={!!checked} onCheckedChange={onChange} />
      <span style={{ fontSize: 13, color: 'var(--muted)' }}>{label}</span>
    </label>
  )
}

function Feedback({ msg, isError }) {
  if (!msg) return null
  return (
    <div style={{
      marginTop: 8, borderRadius: 8, padding: '8px 12px', fontSize: 12,
      background: isError ? 'var(--danger-bg)' : 'var(--accent-bg)',
      border: `1px solid ${isError ? 'var(--danger-border)' : 'var(--accent-border)'}`,
      color: isError ? 'var(--danger)' : 'var(--accent-fg)',
    }}>
      {msg}
    </div>
  )
}

function GhostBtn({ onClick, children }) {
  const [hov, setHov] = useState(false)
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        borderRadius: 7,
        border: `1px solid ${hov ? 'var(--accent-border)' : 'var(--border)'}`,
        padding: '6px 14px', fontSize: 11, fontWeight: 500,
        color: hov ? 'var(--accent-fg)' : 'var(--muted)',
        background: hov ? 'var(--accent-bg)' : 'var(--surface)',
        cursor: 'pointer', transition: 'all 0.15s',
      }}
    >
      {children}
    </button>
  )
}

/* ── Histórico de Alertas ── */
const SEV_COLOR = { CRITICAL: 'var(--danger)', HIGH: 'var(--warn)', MEDIUM: 'var(--sky)', LOW: 'var(--muted)', OK: 'var(--ok)' }
const CH_LABEL  = { email: '✉ E-mail', telegram: '✈ Telegram', webhook: '🔗 Webhook' }

function AlertHistorySection() {
  const [rows, setRows]   = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = () => {
    setLoading(true)
    fetchAlertHistory(50)
      .then(setRows)
      .catch(e => setError(e?.response?.data?.detail ?? e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const fmtDate = (iso) => {
    const d = new Date(iso)
    return d.toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' })
  }

  return (
    <Section title="Histórico de Alertas">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontSize: 11, color: 'var(--dim)' }}>
          {loading ? 'Carregando…' : `${rows.length} registro${rows.length !== 1 ? 's' : ''}`}
        </span>
        <button
          onClick={load} disabled={loading}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '4px 10px', borderRadius: 7, fontSize: 11,
            border: '1px solid var(--border)', background: 'var(--surface)',
            color: 'var(--muted)', cursor: 'pointer',
            opacity: loading ? 0.5 : 1,
          }}
        >
          <RefreshCw size={11} style={{ animation: loading ? 'spin 1s linear infinite' : undefined }} />
          Atualizar
        </button>
      </div>

      {error && (
        <div style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', color: 'var(--danger)', fontSize: 12 }}>
          {error}
        </div>
      )}

      {!loading && !error && rows.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--dim)', fontSize: 13 }}>
          Nenhum alerta disparado ainda.
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Data/Hora', 'Canal', 'Severidade', 'Problema', 'Fila', 'Status'].map(h => (
                  <th key={h} style={{ padding: '6px 8px', textAlign: 'left', fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--dim)', fontWeight: 700, whiteSpace: 'nowrap' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} style={{ background: i % 2 === 0 ? 'var(--surface)' : 'var(--card)', borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '7px 8px', color: 'var(--muted)', whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: 11 }}>
                    {fmtDate(r.sent_at)}
                  </td>
                  <td style={{ padding: '7px 8px', color: 'var(--text)' }}>
                    {CH_LABEL[r.channel] ?? r.channel}
                  </td>
                  <td style={{ padding: '7px 8px' }}>
                    <span style={{
                      display: 'inline-block', padding: '1px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700,
                      background: 'color-mix(in srgb, ' + (SEV_COLOR[r.severity] ?? 'var(--dim)') + ' 15%, transparent)',
                      color: SEV_COLOR[r.severity] ?? 'var(--dim)',
                      border: `1px solid color-mix(in srgb, ${SEV_COLOR[r.severity] ?? 'var(--dim)'} 40%, transparent)`,
                    }}>
                      {r.severity}
                    </span>
                  </td>
                  <td style={{ padding: '7px 8px', color: 'var(--text)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={r.problem}>
                    {r.problem}
                  </td>
                  <td style={{ padding: '7px 8px', color: 'var(--muted)', textAlign: 'right', fontFamily: 'monospace', fontSize: 11 }}>
                    {r.queue_total}
                  </td>
                  <td style={{ padding: '7px 8px' }}>
                    {r.success ? (
                      <span style={{ color: 'var(--ok)', fontSize: 11, fontWeight: 600 }}>✓ OK</span>
                    ) : (
                      <span style={{ color: 'var(--danger)', fontSize: 11, fontWeight: 600 }} title={r.error_msg ?? ''}>✗ Falha</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </Section>
  )
}

/* ── Principal ── */
export default function Settings() {
  const { activeServer } = useServer()
  const serverId = activeServer?.id ?? null

  const [cfg, setCfg]         = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [saveErr, setSaveErr] = useState(false)
  const [testMsg, setTestMsg] = useState({})

  useEffect(() => {
    setLoading(true)
    fetchAlertSettings(serverId).then(setCfg).catch(() => setCfg({})).finally(() => setLoading(false))
  }, [serverId])

  const set = key => val => setCfg(prev => ({ ...prev, [key]: val }))

  const handleSave = async () => {
    setSaving(true); setSaveMsg('')
    try {
      const updated = await saveAlertSettings(cfg, serverId)
      setCfg(updated); setSaveErr(false); setSaveMsg('Configurações salvas com sucesso.')
    } catch (e) {
      setSaveErr(true); setSaveMsg(e?.response?.data?.detail || 'Erro ao salvar.')
    } finally {
      setSaving(false); setTimeout(() => setSaveMsg(''), 4000)
    }
  }

  const TEST_FN = { email: testEmail, telegram: testTelegram, weeklyReport: testWeeklyReport, monthlyReport: testMonthlyReport, webhook: testWebhook }

  const runTest = async (type) => {
    setTestMsg(prev => ({ ...prev, [type]: { text: 'Enviando…', err: false } }))
    try {
      const res = await TEST_FN[type](serverId)
      setTestMsg(prev => ({ ...prev, [type]: { text: res.message, err: false } }))
    } catch (e) {
      setTestMsg(prev => ({ ...prev, [type]: { text: e?.response?.data?.detail || 'Falha no teste.', err: true } }))
    }
    setTimeout(() => setTestMsg(prev => ({ ...prev, [type]: null })), 6000)
  }

  if (loading || !cfg) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: 'var(--dim)', fontSize: 13 }}>
        Carregando configurações…
      </div>
    )
  }

  return (
    <div>
      {/* Indicador do servidor sendo configurado */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16,
        borderRadius: 8, padding: '9px 14px',
        background: activeServer ? 'var(--accent-bg)' : 'var(--surface)',
        border: `1px solid ${activeServer ? 'var(--accent-border)' : 'var(--border)'}`,
      }}>
        <span style={{ width: 6, height: 6, borderRadius: 999, background: activeServer ? 'var(--sky)' : 'var(--dim)', flexShrink: 0 }} />
        <span style={{ fontSize: 12, color: activeServer ? 'var(--accent-fg)' : 'var(--muted)' }}>
          {activeServer
            ? <>Configurando alertas para: <strong>{activeServer.name}</strong></>
            : 'Configurando alertas padrão (nenhum servidor selecionado)'}
        </span>
      </div>

      {/* E-mail */}
      <Section title="Alertas por E-mail">
        <Toggle checked={!!cfg.email_enabled} onChange={set('email_enabled')} label="Ativar alertas por e-mail" />
        {cfg.email_enabled && (
          <div style={{ marginTop: 16 }}>
            <Field label="Destinatário" hint="Endereço que receberá os alertas">
              <Input value={cfg.email_to} onChange={set('email_to')} placeholder="admin@empresa.com" />
            </Field>
            <Field label="Remetente (From)" hint="Domínio verificado no Resend ou SMTP">
              <Input value={cfg.smtp_from} onChange={set('smtp_from')} placeholder="alertas@seudominio.com" />
            </Field>

            {/* Resend */}
            <div style={{ margin: '12px 0', borderRadius: 10, padding: '14px 16px', background: 'var(--accent-bg)', border: '1px solid var(--accent-border)' }}>
              <p style={{ fontSize: 10, letterSpacing: '0.25em', textTransform: 'uppercase', color: 'var(--accent-fg)', fontWeight: 700, marginBottom: 12 }}>
                Resend (recomendado)
              </p>
              <Field label="Resend API Key" hint="Obtenha em resend.com/api-keys">
                <Input
                  value={cfg.resend_api_key === MASK ? '' : (cfg.resend_api_key || '')}
                  onChange={set('resend_api_key')} type="password"
                  placeholder={cfg.resend_api_key === MASK ? 'Chave salva — altere para trocar' : 're_xxxxxxxxxxxxxxxx'}
                />
              </Field>
              {cfg.resend_api_key && cfg.resend_api_key !== MASK && (
                <p style={{ fontSize: 11, color: 'var(--accent-fg)', marginTop: 4 }}>Resend ativo</p>
              )}
              {cfg.resend_api_key === MASK && (
                <p style={{ fontSize: 11, color: 'var(--accent-fg)', marginTop: 4 }}>Resend configurado</p>
              )}
            </div>

            {/* SMTP */}
            <div style={{ opacity: cfg.resend_api_key ? 0.45 : 1, pointerEvents: cfg.resend_api_key ? 'none' : 'auto' }}>
              <p style={{ fontSize: 10, letterSpacing: '0.22em', textTransform: 'uppercase', color: 'var(--dim)', fontWeight: 700, marginBottom: 12 }}>
                SMTP (fallback)
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <Field label="Servidor SMTP"><Input value={cfg.smtp_host} onChange={set('smtp_host')} placeholder="smtp.sendgrid.net" /></Field>
                <Field label="Porta"><Input value={cfg.smtp_port} onChange={set('smtp_port')} type="number" placeholder="587" /></Field>
                <Field label="Usuário SMTP"><Input value={cfg.smtp_user} onChange={set('smtp_user')} placeholder="apikey" /></Field>
                <Field label="Senha / API Key">
                  <Input value={cfg.smtp_password === MASK ? '' : cfg.smtp_password} onChange={set('smtp_password')} type="password"
                    placeholder={cfg.smtp_password === MASK ? 'Mantida — altere para trocar' : ''} />
                </Field>
              </div>
              <Toggle checked={!!cfg.smtp_tls} onChange={set('smtp_tls')} label="Usar STARTTLS (recomendado)" />
            </div>

            <div style={{ marginTop: 14 }}>
              <GhostBtn onClick={() => runTest('email')}>Enviar e-mail de teste</GhostBtn>
              <Feedback msg={testMsg.email?.text} isError={testMsg.email?.err} />
            </div>
          </div>
        )}
      </Section>

      {/* Telegram */}
      <Section title="Alertas por Telegram">
        <Toggle checked={!!cfg.telegram_enabled} onChange={set('telegram_enabled')} label="Ativar alertas por Telegram" />
        {cfg.telegram_enabled && (
          <div style={{ marginTop: 16 }}>
            <Field label="Bot Token" hint="Obtenha em @BotFather no Telegram — /newbot">
              <Input value={cfg.telegram_bot_token === MASK ? '' : cfg.telegram_bot_token} onChange={set('telegram_bot_token')} type="password"
                placeholder={cfg.telegram_bot_token === MASK ? 'Token salvo — altere para trocar' : '123456789:AAxxxxxx…'} />
            </Field>
            <Field label="Chat ID" hint="Envie /start ao seu bot e consulte api.telegram.org/bot<TOKEN>/getUpdates">
              <Input value={cfg.telegram_chat_id} onChange={set('telegram_chat_id')} placeholder="-1001234567890" />
            </Field>
            <div style={{ marginTop: 14 }}>
              <GhostBtn onClick={() => runTest('telegram')}>Enviar mensagem de teste</GhostBtn>
              <Feedback msg={testMsg.telegram?.text} isError={testMsg.telegram?.err} />
            </div>
          </div>
        )}
      </Section>

      {/* Webhook */}
      <Section title="Webhook Genérico">
        <Field label="URL do webhook" hint="Recebe um POST em JSON (severidade, problema, servidor, timestamp) a cada alerta — deixe em branco para desativar">
          <Input value={cfg.webhook_url} onChange={set('webhook_url')} placeholder="https://seu-endpoint.com/webhook" />
        </Field>
        {cfg.webhook_url && (
          <>
            <Field label="Secret (opcional)" hint="Assina o payload em HMAC-SHA256 — header X-EximMonitor-Signature">
              <Input
                value={cfg.webhook_secret === MASK ? '' : (cfg.webhook_secret || '')}
                onChange={set('webhook_secret')} type="password"
                placeholder={cfg.webhook_secret === MASK ? 'Secret salvo — altere para trocar' : 'opcional'}
              />
            </Field>
            <div style={{ marginTop: 14 }}>
              <GhostBtn onClick={() => runTest('webhook')}>Enviar webhook de teste</GhostBtn>
              <Feedback msg={testMsg.webhook?.text} isError={testMsg.webhook?.err} />
            </div>
          </>
        )}
      </Section>

      {/* Thresholds */}
      <Section title="Condições de disparo">
        <Field label="Severidade mínima para alerta" hint="HIGH = alto risco e crítico. CRITICAL = apenas crítico.">
          <Select value={cfg.severity_threshold} onChange={set('severity_threshold')}>
            {SEVERITY_OPTIONS.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
          </Select>
        </Field>
        <Field label="Alerta se fila ultrapassar (0 = desabilitado)" hint="Dispara mesmo que a severidade ainda não tenha mudado.">
          <Input value={cfg.queue_threshold} onChange={val => set('queue_threshold')(Number(val))} type="number" placeholder="0" />
        </Field>
        <Field label="Cooldown entre alertas (minutos)" hint="Evita flood de notificações para o mesmo evento.">
          <Input value={cfg.cooldown_minutes} onChange={val => set('cooldown_minutes')(Number(val))} type="number" placeholder="30" />
        </Field>
      </Section>

      {/* Custo estimado (Sessão 3, T1) — opcional; sem preencher, nenhuma
          estimativa financeira aparece no relatório de incidente. */}
      <Section title="Custo estimado (opcional)">
        <p style={{ fontSize: 11, color: 'var(--dim)', marginBottom: 14 }}>
          Preencha só se quiser que o relatório de incidente mostre uma estimativa em R$,
          sempre rotulada como estimativa. Deixe em branco para não mostrar nenhum valor financeiro.
        </p>
        <Field label="Custo médio por hora de sysadmin (R$)">
          <Input
            value={cfg.cost_per_sysadmin_hour_brl ?? ''}
            onChange={val => set('cost_per_sysadmin_hour_brl')(val === '' ? null : Number(val))}
            type="number" placeholder="ex: 80"
          />
        </Field>
        <Field label="Custo médio por ticket de suporte (R$)">
          <Input
            value={cfg.cost_per_ticket_brl ?? ''}
            onChange={val => set('cost_per_ticket_brl')(val === '' ? null : Number(val))}
            type="number" placeholder="ex: 25"
          />
        </Field>
      </Section>

      {/* Relatório semanal */}
      <Section title="Relatório Semanal">
        <Toggle
          checked={!!cfg.weekly_report_enabled}
          onChange={set('weekly_report_enabled')}
          label="Enviar resumo semanal por e-mail (saúde, entrega, ações e alertas do período)"
        />
        {cfg.weekly_report_enabled && (
          <div style={{ marginTop: 14 }}>
            {!cfg.email_to && (
              <p style={{ fontSize: 11, color: 'var(--dim)', marginBottom: 8 }}>
                Configure o destinatário na seção de E-mail acima para o relatório poder ser enviado.
              </p>
            )}
            {cfg.weekly_report_last_sent_at && (
              <p style={{ fontSize: 11, color: 'var(--dim)', marginBottom: 8 }}>
                Último envio: {new Date(cfg.weekly_report_last_sent_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </p>
            )}
            <GhostBtn onClick={() => runTest('weeklyReport')}>Enviar relatório de teste agora</GhostBtn>
            <Feedback msg={testMsg.weeklyReport?.text} isError={testMsg.weeklyReport?.err} />
          </div>
        )}
      </Section>

      {/* Relatório mensal (Sessão 3, T3) — por servidor (aba selecionada com
          um server_id) ou pela frota inteira (seção sem server_id, no
          registro global "servidor padrão"). */}
      <Section title="Relatório Mensal">
        <Toggle
          checked={!!cfg.monthly_report_enabled}
          onChange={set('monthly_report_enabled')}
          label={activeServer
            ? `Enviar resumo mensal por e-mail deste servidor (${activeServer.name}) todo dia 1`
            : 'Enviar resumo mensal por e-mail da frota inteira todo dia 1'}
        />
        <p style={{ fontSize: 11, color: 'var(--dim)', marginTop: 6 }}>
          Incidentes por tipo, MTTR, mensagens recuperadas da quarentena, tempo total em blocklist e evolução da taxa de entrega.
        </p>
        {cfg.monthly_report_enabled && (
          <div style={{ marginTop: 14 }}>
            {!cfg.email_to && (
              <p style={{ fontSize: 11, color: 'var(--dim)', marginBottom: 8 }}>
                Configure o destinatário na seção de E-mail acima para o relatório poder ser enviado.
              </p>
            )}
            {cfg.monthly_report_last_sent_at && (
              <p style={{ fontSize: 11, color: 'var(--dim)', marginBottom: 8 }}>
                Último envio: {new Date(cfg.monthly_report_last_sent_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </p>
            )}
            <GhostBtn onClick={() => runTest('monthlyReport')}>Enviar relatório de teste agora</GhostBtn>
            <Feedback msg={testMsg.monthlyReport?.text} isError={testMsg.monthlyReport?.err} />
          </div>
        )}
      </Section>

      {/* Salvar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 4 }}>
        <button
          onClick={handleSave} disabled={saving}
          style={{
            borderRadius: 8, border: 'none',
            background: saving ? 'var(--sky-dark)' : 'var(--sky)',
            color: '#fff', fontSize: 13, fontWeight: 700,
            padding: '10px 24px', cursor: saving ? 'not-allowed' : 'pointer',
            boxShadow: saving ? 'none' : '0 1px 4px rgba(14,165,233,0.35)',
            transition: 'background 0.15s', opacity: saving ? 0.7 : 1,
          }}
          onMouseEnter={e => { if (!saving) e.currentTarget.style.background = 'var(--sky-dark)' }}
          onMouseLeave={e => { if (!saving) e.currentTarget.style.background = 'var(--sky)' }}
        >
          {saving ? 'Salvando…' : 'Salvar configurações'}
        </button>
        {saveMsg && (
          <span style={{ fontSize: 12, color: saveErr ? 'var(--danger)' : 'var(--accent-fg)', fontWeight: 500 }}>{saveMsg}</span>
        )}
      </div>

      {/* Histórico de Alertas */}
      <div style={{ marginTop: 20 }}>
        <AlertHistorySection />
      </div>

    </div>
  )
}
