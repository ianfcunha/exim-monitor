/**
 * Configurações de alertas — identidade AVILI light profissional.
 */
import { ArrowLeft } from 'lucide-react'
import { useEffect, useState } from 'react'
import { fetchAlertSettings, saveAlertSettings, testEmail, testTelegram } from '../api/client'

const SEVERITY_OPTIONS = ['HIGH', 'CRITICAL']
const MASK = '••••••••'

const inputStyle = {
  width: '100%', borderRadius: 8,
  background: '#F8FAFC', border: '1px solid #E2E8F0',
  padding: '9px 13px', fontSize: 12, color: '#0F172A', outline: 'none',
  transition: 'border-color 0.15s, box-shadow 0.15s',
}

/* ── Primitivos ── */
function Section({ title, children }) {
  return (
    <div style={{
      background: '#fff', border: '1px solid #E2E8F0', borderRadius: 12,
      padding: '20px 20px 16px', marginBottom: 12,
      boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
    }}>
      <p style={{ fontSize: 10, letterSpacing: '0.30em', textTransform: 'uppercase', color: '#0EA5E9', fontWeight: 700, marginBottom: 16 }}>
        {title}
      </p>
      {children}
    </div>
  )
}

function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#64748B', marginBottom: 5 }}>
        {label}
      </label>
      {hint && <p style={{ fontSize: 11, color: '#94A3B8', marginBottom: 6 }}>{hint}</p>}
      {children}
    </div>
  )
}

function Input({ value, onChange, type = 'text', placeholder = '' }) {
  return (
    <input
      type={type} value={value ?? ''} onChange={e => onChange(e.target.value)}
      placeholder={placeholder} style={inputStyle}
      onFocus={e => { e.target.style.borderColor = '#0EA5E9'; e.target.style.boxShadow = '0 0 0 3px rgba(14,165,233,0.10)' }}
      onBlur={e  => { e.target.style.borderColor = '#E2E8F0'; e.target.style.boxShadow = 'none' }}
    />
  )
}

function Select({ value, onChange, children }) {
  return (
    <select value={value ?? ''} onChange={e => onChange(e.target.value)} style={{ ...inputStyle, cursor: 'pointer', background: '#F8FAFC' }}>
      {children}
    </select>
  )
}

function Toggle({ checked, onChange, label }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', userSelect: 'none' }}>
      <div
        onClick={() => onChange(!checked)}
        style={{
          position: 'relative', width: 40, height: 22, borderRadius: 11, flexShrink: 0,
          background: checked ? '#0EA5E9' : '#E2E8F0',
          border: `1px solid ${checked ? '#0284C7' : '#CBD5E1'}`,
          transition: 'background 0.2s, border-color 0.2s',
        }}
      >
        <span style={{
          position: 'absolute', top: 2, left: checked ? 19 : 2,
          width: 16, height: 16, borderRadius: '50%',
          background: 'white', boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
          transition: 'left 0.2s',
        }} />
      </div>
      <span style={{ fontSize: 13, color: '#64748B' }}>{label}</span>
    </label>
  )
}

function Feedback({ msg, isError }) {
  if (!msg) return null
  return (
    <div style={{
      marginTop: 8, borderRadius: 8, padding: '8px 12px', fontSize: 12,
      background: isError ? '#FEF2F2' : '#F0F9FF',
      border: `1px solid ${isError ? '#FECACA' : '#BAE6FD'}`,
      color: isError ? '#991B1B' : '#0369A1',
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
        border: `1px solid ${hov ? '#BAE6FD' : '#E2E8F0'}`,
        padding: '6px 14px', fontSize: 11, fontWeight: 500,
        color: hov ? '#0369A1' : '#64748B',
        background: hov ? '#F0F9FF' : '#F8FAFC',
        cursor: 'pointer', transition: 'all 0.15s',
      }}
    >
      {children}
    </button>
  )
}

/* ── Principal ── */
export default function Settings({ onBack }) {
  const [cfg, setCfg]         = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [saveErr, setSaveErr] = useState(false)
  const [testMsg, setTestMsg] = useState({})

  useEffect(() => {
    fetchAlertSettings().then(setCfg).catch(() => setCfg({})).finally(() => setLoading(false))
  }, [])

  const set = key => val => setCfg(prev => ({ ...prev, [key]: val }))

  const handleSave = async () => {
    setSaving(true); setSaveMsg('')
    try {
      const updated = await saveAlertSettings(cfg)
      setCfg(updated); setSaveErr(false); setSaveMsg('Configurações salvas com sucesso.')
    } catch (e) {
      setSaveErr(true); setSaveMsg(e?.response?.data?.detail || 'Erro ao salvar.')
    } finally {
      setSaving(false); setTimeout(() => setSaveMsg(''), 4000)
    }
  }

  const runTest = async (type) => {
    setTestMsg(prev => ({ ...prev, [type]: { text: 'Enviando…', err: false } }))
    try {
      const res = await (type === 'email' ? testEmail() : testTelegram())
      setTestMsg(prev => ({ ...prev, [type]: { text: res.message, err: false } }))
    } catch (e) {
      setTestMsg(prev => ({ ...prev, [type]: { text: e?.response?.data?.detail || 'Falha no teste.', err: true } }))
    }
    setTimeout(() => setTestMsg(prev => ({ ...prev, [type]: null })), 6000)
  }

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: '#94A3B8', fontSize: 13 }}>
        Carregando configurações…
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: '#F1F5F9' }}>

      {/* Header */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 10,
        padding: '0 24px', background: '#fff',
        borderBottom: '1px solid #E2E8F0',
        boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
      }}>
        <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 14, height: 56 }}>
          <button
            onClick={onBack}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 12, color: '#94A3B8', background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              transition: 'color 0.15s',
            }}
            onMouseEnter={e => e.currentTarget.style.color = '#0EA5E9'}
            onMouseLeave={e => e.currentTarget.style.color = '#94A3B8'}
          >
            <ArrowLeft size={14} /> Dashboard
          </button>
          <span style={{ color: '#E2E8F0' }}>|</span>
          <span style={{ fontSize: 10, letterSpacing: '0.28em', textTransform: 'uppercase', color: '#0EA5E9', fontWeight: 700 }}>
            Configurações de Alertas
          </span>
        </div>
      </header>

      <div style={{ maxWidth: 760, margin: '0 auto', padding: '20px 24px' }}>

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
              <div style={{ margin: '12px 0', borderRadius: 10, padding: '14px 16px', background: '#F0F9FF', border: '1px solid #BAE6FD' }}>
                <p style={{ fontSize: 10, letterSpacing: '0.25em', textTransform: 'uppercase', color: '#0369A1', fontWeight: 700, marginBottom: 12 }}>
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
                  <p style={{ fontSize: 11, color: '#0369A1', marginTop: 4 }}>Resend ativo</p>
                )}
                {cfg.resend_api_key === MASK && (
                  <p style={{ fontSize: 11, color: '#0369A1', marginTop: 4 }}>Resend configurado</p>
                )}
              </div>

              {/* SMTP */}
              <div style={{ opacity: cfg.resend_api_key ? 0.45 : 1, pointerEvents: cfg.resend_api_key ? 'none' : 'auto' }}>
                <p style={{ fontSize: 10, letterSpacing: '0.22em', textTransform: 'uppercase', color: '#94A3B8', fontWeight: 700, marginBottom: 12 }}>
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

        {/* Thresholds */}
        <Section title="Condições de disparo">
          <Field label="Severidade mínima para alerta" hint="HIGH = alto risco e crítico. CRITICAL = apenas crítico.">
            <Select value={cfg.severity_threshold} onChange={set('severity_threshold')}>
              {SEVERITY_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </Select>
          </Field>
          <Field label="Alerta se fila ultrapassar (0 = desabilitado)" hint="Dispara mesmo que a severidade ainda não tenha mudado.">
            <Input value={cfg.queue_threshold} onChange={val => set('queue_threshold')(Number(val))} type="number" placeholder="0" />
          </Field>
          <Field label="Cooldown entre alertas (minutos)" hint="Evita flood de notificações para o mesmo evento.">
            <Input value={cfg.cooldown_minutes} onChange={val => set('cooldown_minutes')(Number(val))} type="number" placeholder="30" />
          </Field>
        </Section>

        {/* Salvar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 4 }}>
          <button
            onClick={handleSave} disabled={saving}
            style={{
              borderRadius: 8, border: 'none',
              background: saving ? '#7DD3F0' : '#0EA5E9',
              color: '#fff', fontSize: 13, fontWeight: 700,
              padding: '10px 24px', cursor: saving ? 'not-allowed' : 'pointer',
              boxShadow: saving ? 'none' : '0 1px 4px rgba(14,165,233,0.35)',
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => { if (!saving) e.currentTarget.style.background = '#0284C7' }}
            onMouseLeave={e => { if (!saving) e.currentTarget.style.background = '#0EA5E9' }}
          >
            {saving ? 'Salvando…' : 'Salvar configurações'}
          </button>
          {saveMsg && (
            <span style={{ fontSize: 12, color: saveErr ? '#991B1B' : '#0369A1', fontWeight: 500 }}>{saveMsg}</span>
          )}
        </div>

      </div>
    </div>
  )
}
