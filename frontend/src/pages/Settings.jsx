/**
 * Página de configurações de alertas — identidade AVILI light.
 */
import { ArrowLeft } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  fetchAlertSettings,
  saveAlertSettings,
  testEmail,
  testTelegram,
} from '../api/client'

const SEVERITY_OPTIONS = ['HIGH', 'CRITICAL']
const MASK = '••••••••'

/* ── Primitivos de UI ────────────────────────────────────────────────────── */

function Section({ title, children }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.65)',
      border: '1px solid rgba(255,255,255,0.88)',
      borderRadius: 16, padding: '20px 20px 16px',
      backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
      boxShadow: '0 4px 24px rgba(14,100,180,0.07), inset 0 1px 0 rgba(255,255,255,0.95)',
      marginBottom: 12,
    }}>
      <p style={{ fontSize: 10, letterSpacing: '0.32em', textTransform: 'uppercase', color: '#0EA5E9', fontWeight: 600, marginBottom: 16 }}>
        {title}
      </p>
      {children}
    </div>
  )
}

function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'rgba(15,26,46,0.65)', marginBottom: 5 }}>
        {label}
      </label>
      {hint && <p style={{ fontSize: 11, color: 'rgba(15,26,46,0.40)', marginBottom: 6 }}>{hint}</p>}
      {children}
    </div>
  )
}

function Input({ value, onChange, type = 'text', placeholder = '' }) {
  return (
    <input
      type={type}
      value={value ?? ''}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: '100%', borderRadius: 10,
        background: 'rgba(14,165,233,0.05)',
        border: '1px solid rgba(14,165,233,0.20)',
        padding: '9px 13px', fontSize: 12, color: '#0F1A2E', outline: 'none',
        transition: 'border-color 0.15s',
      }}
      onFocus={e => e.target.style.borderColor = 'rgba(14,165,233,0.50)'}
      onBlur={e  => e.target.style.borderColor = 'rgba(14,165,233,0.20)'}
    />
  )
}

function Select({ value, onChange, children }) {
  return (
    <select
      value={value ?? ''}
      onChange={e => onChange(e.target.value)}
      style={{
        width: '100%', borderRadius: 10,
        background: 'rgba(255,255,255,0.80)',
        border: '1px solid rgba(14,165,233,0.20)',
        padding: '9px 13px', fontSize: 12, color: '#0F1A2E', outline: 'none',
        cursor: 'pointer',
      }}
    >
      {children}
    </select>
  )
}

function Toggle({ checked, onChange, label }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', userSelect: 'none' }}>
      <div
        onClick={() => onChange(!checked)}
        style={{
          position: 'relative', width: 42, height: 24, borderRadius: 12,
          background: checked ? '#0EA5E9' : 'rgba(15,26,46,0.12)',
          border: `1px solid ${checked ? 'rgba(14,165,233,0.55)' : 'rgba(15,26,46,0.15)'}`,
          transition: 'background 0.2s, border-color 0.2s', flexShrink: 0,
        }}
      >
        <span style={{
          position: 'absolute', top: 3, left: checked ? 20 : 3,
          width: 16, height: 16, borderRadius: '50%',
          background: 'white', boxShadow: '0 1px 4px rgba(0,0,0,0.18)',
          transition: 'left 0.2s',
        }} />
      </div>
      <span style={{ fontSize: 13, color: 'rgba(15,26,46,0.70)' }}>{label}</span>
    </label>
  )
}

function Feedback({ msg, isError }) {
  if (!msg) return null
  return (
    <div style={{
      marginTop: 8, borderRadius: 8, padding: '8px 12px', fontSize: 12,
      background: isError ? 'rgba(239,68,68,0.07)' : 'rgba(14,165,233,0.08)',
      border: `1px solid ${isError ? 'rgba(239,68,68,0.28)' : 'rgba(14,165,233,0.22)'}`,
      color: isError ? '#DC2626' : '#0369A1',
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
        borderRadius: 8, border: `1px solid ${hov ? 'rgba(14,165,233,0.45)' : 'rgba(14,165,233,0.28)'}`,
        padding: '6px 14px', fontSize: 11, fontWeight: 500,
        color: hov ? '#0284C7' : '#0EA5E9',
        background: hov ? 'rgba(14,165,233,0.08)' : 'transparent',
        cursor: 'pointer', transition: 'all 0.15s',
      }}
    >
      {children}
    </button>
  )
}

/* ── Componente principal ────────────────────────────────────────────────── */

export default function Settings({ onBack }) {
  const [cfg, setCfg]         = useState(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [saveErr, setSaveErr] = useState(false)
  const [testMsg, setTestMsg] = useState({})

  useEffect(() => {
    fetchAlertSettings()
      .then(setCfg)
      .catch(() => setCfg({}))
      .finally(() => setLoading(false))
  }, [])

  const set = (key) => (val) => setCfg(prev => ({ ...prev, [key]: val }))

  const handleSave = async () => {
    setSaving(true)
    setSaveMsg('')
    try {
      const updated = await saveAlertSettings(cfg)
      setCfg(updated)
      setSaveErr(false)
      setSaveMsg('Configurações salvas com sucesso.')
    } catch (e) {
      setSaveErr(true)
      setSaveMsg(e?.response?.data?.detail || 'Erro ao salvar.')
    } finally {
      setSaving(false)
      setTimeout(() => setSaveMsg(''), 4000)
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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: 'rgba(15,26,46,0.40)', fontSize: 13 }}>
        Carregando configurações…
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', color: 'var(--text)' }}>

      {/* Header */}
      <header
        className="header-accent"
        style={{
          position: 'sticky', top: 0, zIndex: 10,
          padding: '0 24px',
          borderBottom: '1px solid rgba(14,165,233,0.14)',
          background: 'rgba(238,242,247,0.85)',
          backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)',
          boxShadow: '0 1px 12px rgba(14,100,180,0.06)',
        }}
      >
        <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', alignItems: 'center', gap: 16, height: 54 }}>
          <button
            onClick={onBack}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 12, color: 'rgba(15,26,46,0.45)', background: 'none',
              border: 'none', cursor: 'pointer', padding: 0, transition: 'color 0.15s',
            }}
            onMouseEnter={e => e.currentTarget.style.color = '#0EA5E9'}
            onMouseLeave={e => e.currentTarget.style.color = 'rgba(15,26,46,0.45)'}
          >
            <ArrowLeft size={14} />
            Dashboard
          </button>
          <span style={{ color: 'rgba(15,26,46,0.15)' }}>|</span>
          <span className="section-label" style={{ letterSpacing: '0.22em' }}>Configurações de Alertas</span>
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
              <div style={{
                margin: '12px 0', borderRadius: 12, padding: '14px 16px',
                background: 'rgba(14,165,233,0.05)',
                border: '1px solid rgba(14,165,233,0.18)',
              }}>
                <p style={{ fontSize: 10, letterSpacing: '0.25em', textTransform: 'uppercase', color: '#0EA5E9', fontWeight: 600, marginBottom: 12 }}>
                  Resend (recomendado)
                </p>
                <Field label="Resend API Key" hint="Quando configurada, usa o Resend em vez de SMTP. Obtenha em resend.com/api-keys">
                  <Input
                    value={cfg.resend_api_key === MASK ? '' : (cfg.resend_api_key || '')}
                    onChange={set('resend_api_key')}
                    type="password"
                    placeholder={cfg.resend_api_key === MASK ? 'Chave salva — altere para trocar' : 're_xxxxxxxxxxxxxxxx'}
                  />
                </Field>
                {(cfg.resend_api_key && cfg.resend_api_key !== MASK) && (
                  <p style={{ fontSize: 11, color: '#0369A1', marginTop: 4 }}>Resend ativo</p>
                )}
                {cfg.resend_api_key === MASK && (
                  <p style={{ fontSize: 11, color: '#0369A1', marginTop: 4 }}>Resend configurado</p>
                )}
              </div>

              {/* SMTP fallback */}
              <div style={{ opacity: cfg.resend_api_key ? 0.4 : 1, pointerEvents: cfg.resend_api_key ? 'none' : 'auto' }}>
                <p style={{ fontSize: 10, letterSpacing: '0.22em', textTransform: 'uppercase', color: 'rgba(15,26,46,0.35)', fontWeight: 600, marginBottom: 12 }}>
                  SMTP (fallback)
                </p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <Field label="Servidor SMTP"><Input value={cfg.smtp_host} onChange={set('smtp_host')} placeholder="smtp.sendgrid.net" /></Field>
                  <Field label="Porta"><Input value={cfg.smtp_port} onChange={set('smtp_port')} type="number" placeholder="587" /></Field>
                  <Field label="Usuário SMTP"><Input value={cfg.smtp_user} onChange={set('smtp_user')} placeholder="apikey" /></Field>
                  <Field label="Senha / API Key">
                    <Input
                      value={cfg.smtp_password === MASK ? '' : cfg.smtp_password}
                      onChange={set('smtp_password')}
                      type="password"
                      placeholder={cfg.smtp_password === MASK ? 'Mantida — altere para trocar' : ''}
                    />
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
                <Input
                  value={cfg.telegram_bot_token === MASK ? '' : cfg.telegram_bot_token}
                  onChange={set('telegram_bot_token')}
                  type="password"
                  placeholder={cfg.telegram_bot_token === MASK ? 'Token salvo — altere para trocar' : '123456789:AAxxxxxx…'}
                />
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 4 }}>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              borderRadius: 10, border: 'none',
              background: saving ? 'rgba(14,165,233,0.55)' : '#0EA5E9',
              color: 'white', fontSize: 13, fontWeight: 600,
              padding: '10px 24px', cursor: saving ? 'not-allowed' : 'pointer',
              transition: 'background 0.15s',
              boxShadow: '0 2px 12px rgba(14,165,233,0.28)',
            }}
            onMouseEnter={e => { if (!saving) e.currentTarget.style.background = '#0284C7' }}
            onMouseLeave={e => { if (!saving) e.currentTarget.style.background = '#0EA5E9' }}
          >
            {saving ? 'Salvando…' : 'Salvar configurações'}
          </button>
          {saveMsg && (
            <span style={{ fontSize: 12, color: saveErr ? '#DC2626' : '#0369A1' }}>{saveMsg}</span>
          )}
        </div>

      </div>
    </div>
  )
}
