/**
 * UsersPage — gerenciamento de usuários e convites.
 * Acessível via dropdown Configurações → Usuários.
 */
import { ArrowLeft, Clock, Copy, Link, Mail, RefreshCw, RotateCcw, Shield, Trash2, UserPlus, Users, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { deleteUser, fetchUsers, getInviteLink, inviteUser, resendInvite, updateUserRole } from '../api/client'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuth } from '../contexts/AuthContext'

const ROLE_LABEL = { admin: 'Admin', viewer: 'Viewer' }
const ROLE_COLOR = { admin: '#0369A1', viewer: '#64748B' }
const ROLE_BG    = { admin: '#F0F9FF', viewer: '#F8FAFC' }

const inputStyle = {
  width: '100%', padding: '9px 13px', borderRadius: 8, fontSize: 12,
  border: '1px solid #E2E8F0', outline: 'none', color: '#0F172A',
  background: '#F8FAFC', boxSizing: 'border-box',
  transition: 'border-color 0.15s',
}

export default function UsersPage({ onBack }) {
  const { userId: currentUserId } = useAuth()
  const [users, setUsers]         = useState([])
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)
  const [showForm, setShowForm]   = useState(false)
  const [email, setEmail]         = useState('')
  const [role, setRole]           = useState('viewer')
  const [sending, setSending]     = useState(false)
  const [inviteMsg, setInviteMsg] = useState(null)
  const [resending, setResending] = useState({})   // { [userId]: true }
  const [changingRole, setChangingRole] = useState({}) // { [userId]: true }
  const [linkModal, setLinkModal] = useState(null) // { email, url, expires_in_hours }
  const [copied, setCopied]       = useState(false)

  const load = () => {
    setLoading(true)
    setError(null)
    fetchUsers()
      .then(setUsers)
      .catch(e => setError(e?.response?.data?.detail ?? e.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const handleInvite = async (e) => {
    e.preventDefault()
    setSending(true)
    setInviteMsg(null)
    try {
      const res = await inviteUser({ email, role })
      setInviteMsg({ ok: res.ok, text: res.message, url: res.invite_url })
      setEmail('')
      setShowForm(false)
      load()
    } catch (e) {
      setInviteMsg({ ok: false, text: e?.response?.data?.detail ?? 'Erro ao enviar convite.' })
    } finally {
      setSending(false)
    }
  }

  const handleResend = async (id) => {
    setResending(r => ({ ...r, [id]: true }))
    try {
      const res = await resendInvite(id)
      setInviteMsg({ ok: res.ok, text: res.message, url: res.invite_url })
    } catch (e) {
      setInviteMsg({ ok: false, text: e?.response?.data?.detail ?? 'Erro ao reenviar convite.' })
    } finally {
      setResending(r => ({ ...r, [id]: false }))
    }
  }

  const handleViewLink = async (id) => {
    try {
      const res = await getInviteLink(id)
      setLinkModal(res)
      setCopied(false)
    } catch (e) {
      setError(e?.response?.data?.detail ?? 'Erro ao obter link.')
    }
  }

  const handleCopy = () => {
    if (linkModal?.invite_url) {
      navigator.clipboard.writeText(linkModal.invite_url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const handleDelete = async (id, username) => {
    if (!confirm(`Remover "${username}"? O acesso será revogado imediatamente.`)) return
    try {
      await deleteUser(id)
      load()
    } catch (e) {
      setError(e?.response?.data?.detail ?? e.message)
    }
  }

  const handleRoleChange = async (id, username, newRole) => {
    if (!confirm(`Alterar "${username}" para ${ROLE_LABEL[newRole]}? O acesso atual dele será encerrado e ele precisará logar novamente.`)) return
    setChangingRole(r => ({ ...r, [id]: true }))
    try {
      const res = await updateUserRole(id, newRole)
      setInviteMsg({ ok: res.ok, text: res.message })
      load()
    } catch (e) {
      setError(e?.response?.data?.detail ?? e.message)
    } finally {
      setChangingRole(r => ({ ...r, [id]: false }))
    }
  }

  const fmt = (iso) => iso
    ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—'

  return (
    <div style={{ minHeight: '100vh', background: '#F1F5F9' }}>

      {/* Header */}
      <header style={{
        position: 'sticky', top: 0, zIndex: 10,
        padding: '0 24px', background: '#fff',
        borderBottom: '1px solid #E2E8F0',
        boxShadow: '0 1px 4px rgba(0,0,0,0.05)',
      }}>
        <div style={{ maxWidth: 760, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 56, gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <button onClick={onBack}
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#94A3B8', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              onMouseEnter={e => e.currentTarget.style.color = '#0EA5E9'}
              onMouseLeave={e => e.currentTarget.style.color = '#94A3B8'}
            >
              <ArrowLeft size={14} /> Dashboard
            </button>
            <span style={{ color: '#E2E8F0' }}>|</span>
            <span style={{ fontSize: 10, letterSpacing: '0.28em', textTransform: 'uppercase', color: '#0EA5E9', fontWeight: 700 }}>
              Usuários e Convites
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button onClick={load} title="Atualizar lista"
              style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid #E2E8F0', background: '#F8FAFC', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748B' }}>
              <RefreshCw size={13} style={{ animation: loading ? 'spin 1s linear infinite' : undefined }} />
            </button>
            <button
              onClick={() => { setShowForm(v => !v); setInviteMsg(null) }}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '7px 14px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                border: showForm ? '1px solid #BAE6FD' : '1px solid #E2E8F0',
                background: showForm ? '#F0F9FF' : '#fff',
                color: showForm ? '#0369A1' : '#64748B',
                cursor: 'pointer',
              }}
            >
              <UserPlus size={13} />
              Convidar usuário
            </button>
          </div>
        </div>
      </header>

      <div style={{ maxWidth: 760, margin: '0 auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Formulário de convite */}
        {showForm && (
          <div style={{
            background: '#fff', border: '1px solid #E2E8F0', borderRadius: 12,
            padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
          }}>
            <p style={{ fontSize: 10, letterSpacing: '0.28em', textTransform: 'uppercase', color: '#0EA5E9', fontWeight: 700, marginBottom: 16 }}>
              Novo Convite
            </p>
            <form onSubmit={handleInvite}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 140px auto', gap: 10, alignItems: 'flex-end', marginBottom: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#64748B', marginBottom: 5 }}>
                    E-mail do convidado
                  </label>
                  <input
                    type="email" value={email} onChange={e => setEmail(e.target.value)}
                    placeholder="colega@empresa.com" required style={inputStyle}
                    onFocus={e => e.target.style.borderColor = '#0EA5E9'}
                    onBlur={e  => e.target.style.borderColor = '#E2E8F0'}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#64748B', marginBottom: 5 }}>
                    Perfil
                  </label>
                  <Select value={role} onValueChange={setRole}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="viewer">Viewer</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <button type="submit" disabled={sending} style={{
                  padding: '9px 18px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                  border: 'none', background: sending ? '#7DD3F0' : '#0EA5E9',
                  color: '#fff', cursor: sending ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
                }}>
                  {sending ? 'Enviando…' : 'Enviar convite'}
                </button>
              </div>
              <p style={{ fontSize: 11, color: '#94A3B8' }}>
                <strong style={{ color: '#64748B' }}>Admin</strong> — acesso completo, pode gerenciar servidores e convidar membros. &nbsp;
                <strong style={{ color: '#64748B' }}>Viewer</strong> — somente leitura, sem executar ações.
              </p>
            </form>
          </div>
        )}

        {/* Resultado do convite */}
        {inviteMsg && (
          <div style={{
            padding: '12px 16px', borderRadius: 10, fontSize: 12,
            background: inviteMsg.ok ? '#F0FDF4' : '#FEF2F2',
            border: `1px solid ${inviteMsg.ok ? '#BBF7D0' : '#FECACA'}`,
            color: inviteMsg.ok ? '#166534' : '#991B1B',
          }}>
            {inviteMsg.text}
            {inviteMsg.url && (
              <div style={{ marginTop: 8, wordBreak: 'break-all' }}>
                <strong>Link manual:</strong>{' '}
                <a href={inviteMsg.url} target="_blank" rel="noreferrer"
                  style={{ color: '#0369A1', fontFamily: 'monospace', fontSize: 11 }}>
                  {inviteMsg.url}
                </a>
              </div>
            )}
          </div>
        )}

        {/* Erro */}
        {error && (
          <div style={{ padding: '10px 14px', borderRadius: 10, background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B', fontSize: 12 }}>
            {error}
          </div>
        )}

        {/* Lista */}
        <div style={{
          background: '#fff', border: '1px solid #E2E8F0', borderRadius: 12,
          boxShadow: '0 1px 3px rgba(0,0,0,0.05)', overflow: 'hidden',
        }}>
          {/* Cabeçalho */}
          <div style={{
            padding: '12px 20px', borderBottom: '1px solid #F1F5F9',
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <Users size={13} color="#94A3B8" />
            <span style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600 }}>
              {loading ? '…' : `${users.length} ${users.length === 1 ? 'membro' : 'membros'}`}
            </span>
          </div>

          {/* Conteúdo */}
          {loading ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>
              <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite', marginBottom: 8 }} />
              <div>Carregando…</div>
            </div>
          ) : users.length === 0 ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>
              Nenhum usuário cadastrado ainda.
            </div>
          ) : (
            users.map((u, i) => (
              <div key={u.id} style={{
                display: 'flex', alignItems: 'center', gap: 14,
                padding: '14px 20px',
                borderBottom: i < users.length - 1 ? '1px solid #F1F5F9' : 'none',
              }}>
                {/* Avatar */}
                <div style={{
                  width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                  background: ROLE_BG[u.role], border: `1px solid ${ROLE_COLOR[u.role]}25`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 14, fontWeight: 700, color: ROLE_COLOR[u.role],
                }}>
                  {(u.invite_pending ? u.email : u.username)?.[0]?.toUpperCase() ?? '?'}
                </div>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 2 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#0F172A' }}>
                      {u.invite_pending ? u.email : u.username}
                    </span>

                    {/* Role */}
                    {(!u.invite_pending && u.id !== 0 && u.id !== currentUserId) ? (
                      <Select
                        value={u.role}
                        disabled={changingRole[u.id]}
                        onValueChange={v => handleRoleChange(u.id, u.username, v)}
                      >
                        <SelectTrigger
                          title="Alterar papel"
                          className="h-auto gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-bold [&_svg]:size-2.5"
                          style={{
                            background: ROLE_BG[u.role], color: ROLE_COLOR[u.role],
                            borderColor: `${ROLE_COLOR[u.role]}25`,
                            cursor: changingRole[u.id] ? 'wait' : 'pointer',
                            opacity: changingRole[u.id] ? 0.6 : 1,
                          }}
                        >
                          <Shield size={9} />
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent align="end">
                          <SelectItem value="admin">Admin</SelectItem>
                          <SelectItem value="viewer">Viewer</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 3,
                        fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 999,
                        background: ROLE_BG[u.role], color: ROLE_COLOR[u.role],
                        border: `1px solid ${ROLE_COLOR[u.role]}25`,
                      }}>
                        <Shield size={9} />
                        {ROLE_LABEL[u.role] ?? u.role}
                      </span>
                    )}

                    {/* Status */}
                    {u.invite_pending ? (
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 3,
                        fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 999,
                        background: '#FFFBEB', color: '#D97706', border: '1px solid #FDE68A',
                      }}>
                        <Clock size={9} /> Convite pendente
                      </span>
                    ) : !u.email_verified ? (
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 3,
                        fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 999,
                        background: '#FEF2F2', color: '#DC2626', border: '1px solid #FECACA',
                      }}>
                        <Mail size={9} /> E-mail não verificado
                      </span>
                    ) : null}
                  </div>

                  <div style={{ fontSize: 11, color: '#94A3B8' }}>
                    {u.invite_pending ? 'Aguardando aceite do convite' : u.email}
                    {u.last_login_at && (
                      <span style={{ marginLeft: 10 }}>· último login: {fmt(u.last_login_at)}</span>
                    )}
                  </div>
                </div>

                {/* Ações para convites pendentes */}
                {u.invite_pending && (
                  <>
                    <button
                      onClick={() => handleViewLink(u.id)}
                      title="Ver link do convite"
                      style={{
                        display: 'flex', alignItems: 'center', gap: 4,
                        padding: '5px 10px', borderRadius: 7, fontSize: 11, fontWeight: 500,
                        border: '1px solid #E2E8F0', background: '#F8FAFC',
                        color: '#64748B', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
                      }}
                    >
                      <Link size={11} /> Ver link
                    </button>
                    <button
                      onClick={() => handleResend(u.id)}
                      disabled={resending[u.id]}
                      title="Reenviar convite por e-mail"
                      style={{
                        display: 'flex', alignItems: 'center', gap: 4,
                        padding: '5px 10px', borderRadius: 7, fontSize: 11, fontWeight: 500,
                        border: '1px solid #BAE6FD', background: '#F0F9FF',
                        color: '#0369A1', cursor: resending[u.id] ? 'wait' : 'pointer',
                        whiteSpace: 'nowrap', flexShrink: 0,
                        opacity: resending[u.id] ? 0.6 : 1,
                      }}
                    >
                      <RotateCcw size={11} style={{ animation: resending[u.id] ? 'spin 1s linear infinite' : undefined }} />
                      {resending[u.id] ? 'Enviando…' : 'Reenviar'}
                    </button>
                  </>
                )}

                {/* Remover */}
                {u.id !== 0 && (
                  <button
                    onClick={() => handleDelete(u.id, u.invite_pending ? u.email : u.username)}
                    title="Revogar acesso"
                    style={{
                      width: 32, height: 32, borderRadius: 8, flexShrink: 0,
                      border: '1px solid #FECACA', background: '#FEF2F2',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'pointer', color: '#DC2626',
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

      {/* ── Modal de link de convite ── */}
      {linkModal && (
        <>
          <div onClick={() => setLinkModal(null)} style={{
            position: 'fixed', inset: 0, zIndex: 100,
            background: 'rgba(15,23,42,0.35)', backdropFilter: 'blur(2px)',
          }} />
          <div style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
            zIndex: 101, background: '#fff', borderRadius: 14,
            border: '1px solid #E2E8F0', boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
            padding: '24px', width: 'min(520px, 90vw)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A', marginBottom: 2 }}>
                  Link de Convite
                </div>
                <div style={{ fontSize: 12, color: '#94A3B8' }}>
                  Para: <strong style={{ color: '#64748B' }}>{linkModal.email}</strong>
                  {linkModal.expires_in_hours != null && (
                    <span> · expira em {linkModal.expires_in_hours}h</span>
                  )}
                </div>
              </div>
              <button onClick={() => setLinkModal(null)} style={{
                width: 28, height: 28, borderRadius: 7, border: '1px solid #E2E8F0',
                background: '#F8FAFC', cursor: 'pointer', display: 'flex',
                alignItems: 'center', justifyContent: 'center', color: '#94A3B8',
              }}>
                <X size={13} />
              </button>
            </div>

            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 12px', borderRadius: 8,
              background: '#F8FAFC', border: '1px solid #E2E8F0',
              marginBottom: 14,
            }}>
              <span style={{
                flex: 1, fontSize: 11, fontFamily: 'monospace', color: '#0F172A',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {linkModal.invite_url}
              </span>
              <button onClick={handleCopy} style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                border: 'none', background: copied ? '#F0FDF4' : '#0EA5E9',
                color: copied ? '#16A34A' : '#fff', cursor: 'pointer', flexShrink: 0,
                transition: 'all 0.2s',
              }}>
                <Copy size={11} />
                {copied ? 'Copiado!' : 'Copiar'}
              </button>
            </div>

            <a href={linkModal.invite_url} target="_blank" rel="noreferrer" style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: '8px 0', borderRadius: 8, fontSize: 12, fontWeight: 600,
              border: '1px solid #E2E8F0', background: '#F8FAFC',
              color: '#64748B', textDecoration: 'none',
            }}>
              <Link size={12} /> Abrir link em nova aba
            </a>
          </div>
        </>
      )}
    </div>
  )
}
