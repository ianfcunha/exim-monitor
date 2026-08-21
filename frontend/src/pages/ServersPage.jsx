/**
 * ServersPage — CRUD de servidores EXIM.
 * Apenas admins acessam esta página.
 */
import { AlertTriangle, CheckCircle, Edit2, KeyRound, Plus, RefreshCw, Server, Trash2, WifiOff, X, XCircle, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { createServer, deleteServer, fetchServers, testServerConn, updateServer } from '../api/client'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useServer } from '../contexts/ServerContext'

const SSH_STATUS = {
  ok:      { color: 'var(--ok)', bg: 'var(--ok-bg)', label: 'Online',      icon: CheckCircle },
  error:   { color: 'var(--danger)', bg: 'var(--danger-bg)', label: 'Erro SSH',    icon: XCircle     },
  timeout: { color: 'var(--warn)', bg: 'var(--warn-bg)', label: 'Timeout',     icon: WifiOff     },
  unknown: { color: 'var(--dim)', bg: 'var(--surface)', label: 'Desconhecido',icon: Server      },
}

const CHECK_LABELS = {
  exim_binary:      'Binário exim',
  exiqgrep:         'exiqgrep',
  disk_space:       'Espaço em disco',
  mainlog:          'Log do Exim',
  cpanel:           'Ambiente cPanel/WHM',
  csf:              'Firewall CSF',
  imunify360:       'Imunify360',
  open_relay:       'Relay aberto',
  starttls:         'STARTTLS',
  exim_version_cve: 'Versão do Exim',
  // T4 (Sessão 1, pós-auditoria): sondagem de capacidade — ok:false aqui
  // não é erro de conexão, é "este servidor está em modo só-leitura
  // pra essa ação específica" (ver AlertTriangle/INFORMATIONAL_CHECKS
  // abaixo e ActionPanel.jsx, que usa isso pra desabilitar botão).
  cap_remove_messages: 'Remover mensagens da fila',
  cap_manage_firewall: 'Bloquear IP',
  cap_write_blacklist: 'Bloquear remetente',
  cap_quarantine:      'Quarentena antes de remover',
}

// Checks informativos (não indicam falha de conexão/pré-requisito, só dado
// de contexto) — ícone neutro em vez de X vermelho quando ok:false.
const INFORMATIONAL_CHECKS = new Set([
  'cpanel', 'csf', 'imunify360', 'open_relay', 'starttls', 'exim_version_cve',
  'cap_remove_messages', 'cap_manage_firewall', 'cap_write_blacklist', 'cap_quarantine',
])

const inputStyle = {
  width: '100%', borderRadius: 8,
  background: 'var(--surface)', border: '1px solid var(--border)',
  padding: '9px 13px', fontSize: 12, color: 'var(--text)', outline: 'none',
  boxSizing: 'border-box', transition: 'border-color 0.15s',
}

// T4 (Sessão 1, pós-auditoria): sem default "root"/"password" — o
// cliente do form escolhe. "key" como default de autenticação (era
// "password") e confirm_root=false (o backend recusa ssh_user="root"
// sem esse flag true — ver o checkbox de aviso persistente abaixo).
const EMPTY_FORM = {
  name: '', host: '', port: 22, ssh_user: '',
  ssh_auth_type: 'key', ssh_secret: '', script_path: '/root/diag-exim.sh', confirm_root: false,
}

/* ── Sub-componentes ── */

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

function Input({ value, onChange, type = 'text', placeholder = '', required }) {
  return (
    <input
      type={type} value={value ?? ''} onChange={e => onChange(e.target.value)}
      placeholder={placeholder} required={required} style={inputStyle}
      onFocus={e => e.target.style.borderColor = 'var(--sky)'}
      onBlur={e  => e.target.style.borderColor = 'var(--border)'}
    />
  )
}

function ServerStatusBadge({ status }) {
  const cfg = SSH_STATUS[status] ?? SSH_STATUS.unknown
  const Icon = cfg.icon
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
      background: cfg.bg, color: cfg.color,
    }}>
      <Icon size={11} />
      {cfg.label}
    </span>
  )
}

function ServerForm({ initial, onSave, onCancel, saving }) {
  const [form, setForm] = useState(initial ?? EMPTY_FORM)
  const set = key => val => setForm(prev => ({ ...prev, [key]: val }))

  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form) }}
      style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
        <Field label="Nome do servidor *">
          <Input value={form.name} onChange={set('name')} placeholder="Prod EXIM" required />
        </Field>
        <Field label="Host / IP *">
          <Input value={form.host} onChange={set('host')} placeholder="192.168.1.10" required />
        </Field>
        <Field label="Porta SSH">
          <Input value={form.port} onChange={v => set('port')(Number(v))} type="number" placeholder="22" />
        </Field>
        <Field label="Usuário SSH *" hint="Recomendado: mailiq, criado por mailiq-bootstrap.sh (docs/seguranca.md) — não requer root.">
          <Input value={form.ssh_user} onChange={set('ssh_user')} placeholder="mailiq" required />
        </Field>
      </div>

      {form.ssh_user === 'root' && (
        <div style={{
          marginBottom: 14, padding: '10px 12px', borderRadius: 8,
          background: 'var(--danger-bg)', border: '1px solid var(--danger-border)',
        }}>
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 11.5, color: 'var(--danger)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!form.confirm_root}
              onChange={e => set('confirm_root')(e.target.checked)}
              style={{ marginTop: 2, width: 13, height: 13, accentColor: 'var(--danger)', flexShrink: 0 }}
            />
            <span>
              Confirmo que quero conectar como <strong>root</strong> — entendo que isso dá ao Mail IQ
              acesso irrestrito ao servidor. O recomendado é criar o usuário dedicado <code>mailiq</code>
              com <code>mailiq-bootstrap.sh</code> (veja <code>docs/seguranca.md</code>).
            </span>
          </label>
        </div>
      )}

      <Field label="Tipo de autenticação">
        <Select value={form.ssh_auth_type} onValueChange={set('ssh_auth_type')}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="password">Senha SSH</SelectItem>
            <SelectItem value="key">Chave privada (conteúdo)</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      <Field
        label={form.ssh_auth_type === 'key' ? 'Conteúdo da chave privada *' : 'Senha SSH *'}
        hint={
          form.ssh_auth_type === 'key'
            ? 'Cole o conteúdo completo da chave privada (id_rsa, id_ed25519, etc). Nunca preenchido automaticamente.'
            : 'Nunca preenchida automaticamente — insira manualmente.'
        }
      >
        {form.ssh_auth_type === 'key' ? (
          <textarea
            value={form.ssh_secret ?? ''}
            onChange={e => set('ssh_secret')(e.target.value)}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
            rows={6}
            style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 11, resize: 'vertical' }}
            onFocus={e => e.target.style.borderColor = 'var(--sky)'}
            onBlur={e  => e.target.style.borderColor = 'var(--border)'}
          />
        ) : (
          <Input
            value={form.ssh_secret ?? ''}
            onChange={set('ssh_secret')}
            type="password"
            placeholder="••••••••"
          />
        )}
      </Field>

      <Field label="Caminho do script remoto">
        <Input value={form.script_path} onChange={set('script_path')} placeholder="/root/diag-exim.sh" />
      </Field>

      <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 4 }}>
        <button type="button" onClick={onCancel}
          style={{
            padding: '8px 18px', borderRadius: 8, fontSize: 12, fontWeight: 600,
            border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--muted)', cursor: 'pointer',
          }}>
          Cancelar
        </button>
        <button
          type="submit"
          disabled={saving || (form.ssh_user === 'root' && !form.confirm_root)}
          style={{
            padding: '8px 20px', borderRadius: 8, fontSize: 12, fontWeight: 700,
            border: 'none',
            background: (saving || (form.ssh_user === 'root' && !form.confirm_root))
              ? 'color-mix(in srgb, var(--sky) 55%, var(--card))' : 'var(--sky)',
            color: '#fff', cursor: (saving || (form.ssh_user === 'root' && !form.confirm_root)) ? 'not-allowed' : 'pointer',
          }}>
          {saving ? 'Salvando…' : 'Salvar servidor'}
        </button>
      </div>
    </form>
  )
}

/* ── Principal ── */
export default function ServersPage() {
  const { refresh: refreshCtx } = useServer()
  const [servers, setServers]     = useState([])
  const [loading, setLoading]     = useState(true)
  const [showForm, setShowForm]   = useState(false)
  const [editTarget, setEditTarget] = useState(null)
  const [saving, setSaving]       = useState(false)
  const [testing, setTesting]     = useState({})
  const [testResult, setTestResult] = useState({})
  const [error, setError]         = useState(null)
  const [deployNotice, setDeployNotice] = useState(null)

  const load = async () => {
    setLoading(true)
    try {
      setServers(await fetchServers())
    } catch (e) {
      setError(e?.response?.data?.detail ?? e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleSave = async (form) => {
    setSaving(true)
    setError(null)
    setDeployNotice(null)
    try {
      if (editTarget) {
        await updateServer(editTarget.id, form)
      } else {
        const created = await createServer(form)
        setDeployNotice(
          created.script_deployed
            ? { ok: true, msg: `diag-exim.sh enviado com sucesso para ${created.script_path}.` }
            : { ok: false, msg: `Servidor cadastrado, mas não consegui enviar o script automaticamente: ${created.script_deploy_error || 'erro desconhecido'}. Envie manualmente ou tente novamente depois.` }
        )
      }
      setShowForm(false)
      setEditTarget(null)
      await load()
      refreshCtx()
    } catch (e) {
      setError(e?.response?.data?.detail ?? e.message ?? 'Erro ao salvar.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id) => {
    if (!confirm('Remover este servidor? Esta ação não pode ser desfeita.')) return
    try {
      await deleteServer(id)
      await load()
      refreshCtx()
    } catch (e) {
      setError(e?.response?.data?.detail ?? e.message)
    }
  }

  const handleTest = async (id) => {
    setTesting(t => ({ ...t, [id]: true }))
    setTestResult(r => ({ ...r, [id]: null }))
    try {
      const res = await testServerConn(id)
      setTestResult(r => ({ ...r, [id]: res }))
      await load()
    } catch (e) {
      setTestResult(r => ({ ...r, [id]: { ok: false, error: e?.response?.data?.detail ?? e.message } }))
    } finally {
      setTesting(t => ({ ...t, [id]: false }))
    }
  }

  const handleForgetHostKey = async (id) => {
    if (!confirm(
      'Isso esquece a chave do host conhecida. Só faça isso se você reinstalou ' +
      'esse servidor de propósito — caso contrário, a mudança de chave pode ' +
      'indicar um ataque. Continuar?'
    )) return
    try {
      await updateServer(id, { reset_host_key: true })
      setTestResult(r => ({ ...r, [id]: null }))
      await load()
    } catch (e) {
      setError(e?.response?.data?.detail ?? e.message)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 14, marginBottom: 16 }}>
        <span style={{ fontSize: 10, letterSpacing: '0.28em', textTransform: 'uppercase', color: 'var(--sky)', fontWeight: 700 }}>
          Servidores
        </span>
        <div style={{ display: 'flex', gap: 8 }}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button onClick={load}
                style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
                <RefreshCw size={13} style={{ animation: loading ? 'spin 1s linear infinite' : undefined }} />
              </button>
            </TooltipTrigger>
            <TooltipContent>Atualizar lista</TooltipContent>
          </Tooltip>
          <button onClick={() => { setEditTarget(null); setShowForm(true) }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, border: 'none', background: 'var(--sky)', color: '#fff', cursor: 'pointer' }}>
            <Plus size={13} /> Adicionar servidor
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

        {error && (
          <div style={{ padding: '10px 14px', borderRadius: 10, background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', color: 'var(--danger)', fontSize: 12 }}>
            {error}
          </div>
        )}

        {deployNotice && (
          <div style={{
            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10,
            padding: '10px 14px', borderRadius: 10, fontSize: 12,
            background: deployNotice.ok ? 'var(--ok-bg)' : 'var(--warn-bg)',
            border: `1px solid ${deployNotice.ok ? 'var(--ok-border)' : 'var(--warn-border)'}`,
            color: deployNotice.ok ? 'var(--ok)' : 'var(--warn)',
          }}>
            <span>{deployNotice.msg}</span>
            <button onClick={() => setDeployNotice(null)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', opacity: 0.6, flexShrink: 0, padding: 0 }}>
              <X size={13} />
            </button>
          </div>
        )}

        {/* Formulário de adição/edição */}
        {showForm && (
          <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '20px 20px 16px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
            <p style={{ fontSize: 10, letterSpacing: '0.28em', textTransform: 'uppercase', color: 'var(--sky)', fontWeight: 700, marginBottom: 16 }}>
              {editTarget ? 'Editar Servidor' : 'Novo Servidor'}
            </p>
            {error && (
              <div style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 8, background: 'var(--danger-bg)', border: '1px solid var(--danger-border)', color: 'var(--danger)', fontSize: 12 }}>
                {error}
              </div>
            )}
            <ServerForm
              initial={editTarget ? { ...editTarget, ssh_secret: '' } : undefined}
              onSave={handleSave}
              onCancel={() => { setShowForm(false); setEditTarget(null); setError(null) }}
              saving={saving}
            />
          </div>
        )}

        {/* Lista de servidores */}
        {loading ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--dim)', fontSize: 13 }}>
            <RefreshCw size={18} style={{ animation: 'spin 1s linear infinite', marginBottom: 8 }} />
            <div>Carregando servidores…</div>
          </div>
        ) : servers.length === 0 ? (
          <div style={{
            background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
            padding: '48px 24px', textAlign: 'center',
            boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
          }}>
            <Server size={32} color="var(--border)" style={{ marginBottom: 12 }} />
            <p style={{ color: 'var(--muted)', fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Nenhum servidor cadastrado</p>
            <p style={{ color: 'var(--dim)', fontSize: 12 }}>Clique em "Adicionar servidor" para começar.</p>
          </div>
        ) : (
          servers.map(s => {
            const tr = testResult[s.id]
            return (
              <div key={s.id} style={{
                background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
                padding: '16px 20px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
                display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
              }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{s.name}</span>
                    <ServerStatusBadge status={s.ssh_status} />
                    {s.is_root && (
                      <span title="Conectado como root — acesso irrestrito ao servidor. Recomendado: usuário mailiq (docs/seguranca.md)."
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 999,
                          background: 'var(--danger-bg)', color: 'var(--danger)', border: '1px solid var(--danger-border)',
                        }}>
                        <AlertTriangle size={10} /> root
                      </span>
                    )}
                    {!s.is_enabled && (
                      <span style={{ fontSize: 10, padding: '1px 7px', borderRadius: 999, background: 'var(--surface)', color: 'var(--dim)', fontWeight: 600 }}>
                        Desativado
                      </span>
                    )}
                  </div>
                  <div style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--muted)' }}>
                    {s.ssh_user}@{s.host}:{s.port} · {s.script_path}
                  </div>
                  {s.ssh_host_key_fingerprint && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontFamily: 'monospace', fontSize: 10, color: 'var(--dim)', marginTop: 3 }}>
                      <KeyRound size={10} /> {s.ssh_host_key_fingerprint}
                    </div>
                  )}
                  {s.last_connected_at && (
                    <div style={{ fontSize: 10, color: 'var(--dim)', marginTop: 2 }}>
                      Último contato: {new Date(s.last_connected_at).toLocaleString('pt-BR')}
                    </div>
                  )}
                  {s.ssh_error_msg && (
                    <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 4 }}>{s.ssh_error_msg}</div>
                  )}

                  {tr?.status === 'host_key_mismatch' ? (
                    <div style={{ marginTop: 6, padding: '8px 10px', borderRadius: 8, background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, color: 'var(--danger)' }}>
                        <AlertTriangle size={12} /> A chave do host mudou desde o cadastro
                      </div>
                      <p style={{ fontSize: 11, color: 'var(--danger)', margin: '4px 0 6px' }}>{tr.error}</p>
                      <button
                        onClick={() => handleForgetHostKey(s.id)}
                        style={{
                          fontSize: 11, fontWeight: 600, padding: '5px 10px', borderRadius: 6,
                          border: '1px solid var(--danger-border)', background: 'var(--card)', color: 'var(--danger)', cursor: 'pointer',
                        }}>
                        Servidor foi reinstalado — esquecer chave antiga
                      </button>
                    </div>
                  ) : tr?.ok && tr?.host_key_first_seen ? (
                    <div style={{ marginTop: 6, padding: '8px 10px', borderRadius: 8, background: 'var(--ok-bg)', border: '1px solid var(--ok-border)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, color: 'var(--ok)' }}>
                        <KeyRound size={12} /> Primeira conexão — chave do host fixada
                      </div>
                      <p style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--ok)', margin: '4px 0 0' }}>
                        {tr.host_key_fingerprint}
                      </p>
                      <p style={{ fontSize: 10, color: 'var(--ok)', margin: '4px 0 0' }}>
                        Confirme que este é o fingerprint esperado do seu servidor. Conexões futuras com uma chave diferente serão bloqueadas.
                      </p>
                    </div>
                  ) : tr && (
                    <div style={{ fontSize: 11, marginTop: 4, color: tr.ok ? 'var(--ok)' : 'var(--danger)', fontWeight: 600 }}>
                      {tr.ok ? `✓ Conectado em ${tr.latency_ms}ms` : `✗ ${tr.error}`}
                    </div>
                  )}

                  {/* Pré-requisitos do script (--check) — só quando a conexão SSH deu certo */}
                  {tr?.ok && tr?.checks && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 6 }}>
                      {tr.checks.map(c => {
                        const informational = INFORMATIONAL_CHECKS.has(c.check)
                        const Icon = c.ok ? CheckCircle : (informational ? Server : XCircle)
                        const color = c.ok ? 'var(--ok)' : (informational ? 'var(--dim)' : 'var(--danger)')
                        return (
                          <span key={c.check} title={c.detail}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, color }}>
                            <Icon size={11} />
                            {CHECK_LABELS[c.check] ?? c.check}
                          </span>
                        )
                      })}
                    </div>
                  )}
                  {tr?.ok && tr?.check_error && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--warn)', marginTop: 6 }}>
                      <AlertTriangle size={11} />
                      SSH conectou, mas não foi possível validar o script: {tr.check_error}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button
                    onClick={() => handleTest(s.id)}
                    disabled={testing[s.id]}
                    title="Testar conexão SSH"
                    style={{
                      display: 'flex', alignItems: 'center', gap: 5,
                      padding: '6px 12px', borderRadius: 8, fontSize: 11, fontWeight: 600,
                      border: '1px solid var(--accent-border)', background: 'var(--accent-bg)', color: 'var(--accent-fg)',
                      cursor: testing[s.id] ? 'wait' : 'pointer',
                    }}>
                    <Zap size={11} style={{ animation: testing[s.id] ? 'spin 1s linear infinite' : undefined }} />
                    {testing[s.id] ? 'Testando…' : 'Testar'}
                  </button>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => { setEditTarget(s); setShowForm(true); setError(null) }}
                        style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border)', background: 'var(--surface)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
                        <Edit2 size={13} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Editar servidor</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => handleDelete(s.id)}
                        style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid var(--danger-border)', background: 'var(--danger-bg)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--danger)' }}>
                        <Trash2 size={13} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Remover servidor</TooltipContent>
                  </Tooltip>
                </div>
              </div>
            )
          })
        )}
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
