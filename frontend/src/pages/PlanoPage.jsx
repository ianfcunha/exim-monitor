/**
 * Plano de correção — Sessão 6, handoff Mail IQ 2.0.
 *
 * Reskin do fluxo diagnóstico → correção que já existe em
 * IncidentDetail.jsx (Triagem) e ActionPanel.jsx, na apresentação
 * "banner + causa raiz/impacto + stepper + checklist + responsáveis +
 * timeline" do mockup — mas SEM inventar dado que o produto não tem.
 *
 * O mockup modela um stepper fixo de 4 etapas narrativas (Diagnóstico →
 * Isolamento → Correção → Verificação). A máquina de estados real
 * (incident_engine.py) não é essa: `aberto` → `em_observacao` (parou de
 * ser detectado, mas ainda dentro da janela de histerese — não é
 * "sendo corrigido", é "esfriando, ainda não confirmado") → `mitigado`
 * (setado só quando a correção sugerida é aplicada) → `resolvido`. Em
 * vez de forçar a narrativa do mockup sobre um estado que não a segue,
 * o stepper aqui usa os 4 estados REAIS como os 4 nós — mesma forma
 * visual, sem fingir uma etapa que o sistema não tem.
 *
 * A checklist e o "responsáveis" vêm de `events` (IncidentEvent —
 * máquina de estados append-only, com actor e timestamp) e do fluxo
 * plan()→apply() já validado em IncidentDetail — não de um checklist
 * fixo que o mockup inventa.
 *
 * Sessão 6 / retorno #2 — layout de 2 colunas: antes a tela mostrava UM
 * incidente por vez (o mais severo, ou o do :id) e trocar exigia voltar
 * à Triagem ou ao sino. Agora a coluna esquerda lista todos os
 * incidentes ativos da frota + um atalho para o Histórico, e a direita
 * mostra o plano completo do selecionado. /plano/:id continua sendo o
 * deep link; /plano/historico abre a lista de planos já encerrados.
 */
import {
  Check, CheckCircle2, ChevronLeft, ClipboardList, History, Loader2, ShieldOff, XCircle,
} from 'lucide-react'
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import {
  ackIncident, applyIncidentFix, fetchIncident, fetchIncidents,
  planAction, planIncidentFix, resolveIncident, runAction, silenceIncident,
} from '../api/client'
import { ACTIONS, CAP_LABELS } from '../components/ActionPanel'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  SEVERITY_STYLE, STATUS_LABELS, fmtAge, incidentTitle,
} from '../components/incidents/incidentLabels'
import { useServer } from '../contexts/ServerContext'
import { useToast } from '../contexts/ToastContext'

const STATUS_ORDER = ['aberto', 'em_observacao', 'mitigado', 'resolvido']
// Incidente "ativo" = qualquer coisa que não seja `resolvido`. `mitigado`
// entra aqui de propósito: a correção foi aplicada mas o ciclo ainda não
// fechou, e é justamente o momento em que se quer acompanhar de perto.
const ACTIVE_STATUSES = new Set(['aberto', 'em_observacao', 'mitigado'])

const ACTION_LABEL = Object.fromEntries(ACTIONS.map(a => [a.id, a.label]))

const EVENT_LABELS = {
  opened: 'Incidente aberto', escalated: 'Agravado — condição piorou',
  ack: 'Ciência confirmada', silenced: 'Silenciado',
  mitigated: 'Marcado como mitigado', resolved: 'Resolvido',
  reopened: 'Reaberto — voltou a ser detectado',
  // Emitidos pelo motor de detecção (incident_engine.py) fora do trio
  // opened/mitigated/resolved documentado em Incident — não é uma
  // transição de status, é o log de por que a confirmação demorou.
  check_unknown: 'Checagem sem resposta durante a reverificação',
  unverified: 'Não foi possível reverificar — checagem falhou',
}

function fmtDateTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('pt-BR')
}
function fmtTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}
function fmtDuration(seconds) {
  if (seconds == null) return '—'
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  if (h === 0) return `${m}min`
  return `${h}h${m > 0 ? ` ${m}min` : ''}`
}
function initials(name) {
  return String(name || '?').trim().slice(0, 2).toUpperCase()
}

// ── Empty state: nenhum incidente aberto no momento ─────────────────────
function NoActiveIncident() {
  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '48px 24px', width: '100%' }}>
      <div style={{
        background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
        padding: '28px 24px', textAlign: 'center', maxWidth: 520, margin: '0 auto',
      }}>
        <ClipboardList size={22} color="var(--dim)" style={{ marginBottom: 10 }} />
        <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: '0 0 6px' }}>
          Nenhum incidente ativo no momento
        </p>
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 18px', lineHeight: 1.55 }}>
          O plano de correção aparece aqui assim que um incidente for detectado
          em qualquer servidor da frota.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Link to="/triage"><Button size="sm" variant="outline">Ir para a Triagem</Button></Link>
          <Link to="/plano/historico"><Button size="sm" variant="outline"><History size={12} /> Ver histórico</Button></Link>
        </div>
      </div>
    </div>
  )
}

// Fase ao vivo de uma ação em andamento — não é o `status` persistido do
// incidente (esse só muda quando o backend confirma), é o feedback
// imediato de "o que este clique está fazendo agora".
const PHASE_LABELS = {
  aguardando: 'Aguardando prévia…',
  agindo:     'Aplicando correção…',
  concluido:  'Ação concluída — atualizando estado…',
  erro:       'A ação falhou — veja o aviso abaixo',
}
const PHASE_COLOR = {
  aguardando: 'var(--warn)', agindo: 'var(--warn)',
  concluido:  'var(--ok)',   erro:   'var(--danger)',
}

// ── Stepper — 4 estados reais do incidente, não uma narrativa fixa ──────
function Stepper({ status, livePhase = 'ocioso' }) {
  const idx = STATUS_ORDER.indexOf(status)
  const resolved = status === 'resolvido'
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '22px 32px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>Estado do incidente</span>
        {livePhase !== 'ocioso' && (
          <span style={{
            display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 600,
            color: PHASE_COLOR[livePhase], background: 'var(--surface)', border: `1px solid ${PHASE_COLOR[livePhase]}`,
            borderRadius: 999, padding: '2px 10px',
          }}>
            {(livePhase === 'aguardando' || livePhase === 'agindo') && (
              <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} />
            )}
            {PHASE_LABELS[livePhase]}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        {STATUS_ORDER.map((s, i) => {
          // Resolvido fecha a história inteira — os nós anteriores contam
          // como concluídos ainda que o incidente tenha pulado
          // `mitigado` (resolução automática por histerese, sem correção
          // aplicada) — o que aconteceu de fato está na Timeline abaixo,
          // isto é só a posição no ciclo de vida.
          const done = resolved ? true : i < idx
          const current = !resolved && i === idx
          const circleBg = done ? 'var(--ok-bg)' : current ? 'var(--warn-bg)' : 'var(--surface-alt)'
          const circleBorder = done ? 'var(--ok)' : current ? 'var(--warn)' : 'var(--border)'
          return (
            <Fragment key={s}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9, flex: 'none', width: 140 }}>
                <div style={{
                  width: 38, height: 38, borderRadius: '50%', background: circleBg,
                  border: `2.5px solid ${circleBorder}`, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  animation: current ? 'pulse-sky 1.4s ease-in-out infinite' : undefined,
                }}>
                  {done ? (
                    <Check size={14} color="var(--ok)" strokeWidth={2.5} />
                  ) : current ? (
                    <div style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--warn)' }} />
                  ) : (
                    <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--dim)' }}>{i + 1}</span>
                  )}
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: done ? 'var(--ok)' : current ? 'var(--warn)' : 'var(--dim)' }}>
                    {STATUS_LABELS[s]}
                  </div>
                </div>
              </div>
              {i < STATUS_ORDER.length - 1 && (
                <div style={{ flex: 1, height: 2.5, background: done ? 'var(--ok)' : 'var(--border)', marginBottom: 30 }} />
              )}
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}

// Quanto tempo o badge "concluído"/"falhou" fica visível no Stepper antes
// de voltar a 'ocioso' — só feedback, o dado real já está atualizado
// antes disso (onApplied roda no mesmo instante que o phase vira
// 'concluido').
const PHASE_RESET_MS = 2500

function missingCapReason(action, capabilities) {
  if (!capabilities || !action.requiredCaps?.length) return null
  const missing = action.requiredCaps.filter(c => capabilities[c] === false)
  if (missing.length === 0) return null
  return `Este servidor está em modo somente leitura para esta ação — falta permissão para ${missing.map(c => CAP_LABELS[c] ?? c).join(' e ')}.`
}

// Quais ações do catálogo do ActionPanel fazem sentido para cada tipo de
// incidente — sem isto, "Bloquear IP"/"Bloquear remetente" apareciam
// como opção pra uma fila travada, o que não tem relação nenhuma com a
// causa. Chave é `${type}:${subtype}`; tipos sem entrada aqui (reputação,
// adiamento por destino) só mostram a sugerida, se houver uma.
const RELEVANT_ACTION_IDS = {
  'queue_stuck:fila':   ['retry-queue', 'clean-sender', 'clean-bounces'],
  'queue_stuck:frozen': ['clean-frozen', 'retry-queue'],
  // auth_abuse: a ação sugerida (clean-auth, com a conta como parâmetro)
  // já vem fixada; bloquear o endereço do remetente não para uma conta
  // comprometida — quem para é limpar a fila dela + o admin trocar a senha.
  'auth_abuse:conta':   ['clean-auth'],
}

// ── Ações disponíveis — marca uma ou mais opções (a sugerida vem
// pré-marcada), gera o preview de todas de uma vez e só aplica depois de
// confirmar num popup — nada roda antes disso. Sessão 6/retorno: antes
// era seleção única (rádio) com o catálogo inteiro do ActionPanel
// (Fila); agora é seleção múltipla (checkbox) restrita ao que faz
// sentido pro tipo do incidente (RELEVANT_ACTION_IDS), e um botão único
// "Aplicar plano de correção" cobre 1 ou várias ações marcadas. Aplicar
// a sugerida usa a rota específica do incidente (marca `mitigado` de
// verdade); as demais são ações gerais do servidor — não mudam o status
// do incidente sozinhas, por isso "Confirmar ciência"/"Resolver" no
// banner continuam sendo a forma de fechar o ciclo quando a sugerida não
// foi uma das marcadas.
function ActionOptions({ incident, server, isResolved, onApplied, onPhaseChange }) {
  const toast = useToast()
  const suggested = incident.suggested_fix?.action

  const options = useMemo(() => {
    const list = []
    if (suggested?.action) {
      const meta = ACTIONS.find(a => a.id === suggested.action)
      list.push({
        id: suggested.action, label: meta?.label ?? suggested.action, Icon: meta?.Icon ?? Check,
        requiredCaps: meta?.requiredCaps ?? [], isSuggested: true,
      })
    }
    const relevantIds = RELEVANT_ACTION_IDS[`${incident.type}:${incident.subtype ?? ''}`] ?? []
    for (const a of ACTIONS) {
      if (a.id === suggested?.action || !relevantIds.includes(a.id)) continue
      list.push({
        id: a.id, label: a.label, Icon: a.Icon, requiredCaps: a.requiredCaps,
        isSuggested: false, hasParam: !!a.param, placeholder: a.placeholder, paramKind: a.param,
        destructive: a.tier === 'destrutiva',
      })
    }
    return list
  }, [suggested, incident.type, incident.subtype])

  const [selectedIds, setSelectedIds] = useState(() => new Set(suggested?.action ? [suggested.action] : []))
  const [paramValues, setParamValues] = useState({})
  const [paramErrors, setParamErrors] = useState({})
  const [snapshot, setSnapshot]         = useState(true)
  const [planningAll, setPlanningAll]   = useState(false)
  const [applyingAll, setApplyingAll]   = useState(false)
  // null = popup fechado; array = previews prontos, popup de confirmação aberto
  const [previews, setPreviews] = useState(null)

  const setPhase = (p) => {
    onPhaseChange?.(p)
    if (p === 'concluido' || p === 'erro') {
      setTimeout(() => onPhaseChange?.('ocioso'), PHASE_RESET_MS)
    }
  }

  const toggle = (opt) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(opt.id) ? next.delete(opt.id) : next.add(opt.id)
      return next
    })
    setParamErrors(prev => ({ ...prev, [opt.id]: '' }))
  }

  const capReason = (opt) => {
    if (!server) return 'Servidor não encontrado — recarregue a página.'
    if (server.observation_mode) {
      return `${server.name} está em modo observação — desligue em Configurações → Servidores para aplicar ações.`
    }
    return missingCapReason(opt, server.capabilities)
  }

  const selected = options.filter(o => selectedIds.has(o.id))

  const validateParams = () => {
    const errors = {}
    let ok = true
    for (const opt of selected) {
      if (!opt.hasParam) continue
      const v = (paramValues[opt.id] || '').trim()
      if (!v) { errors[opt.id] = 'Campo obrigatório'; ok = false; continue }
      if (opt.paramKind === 'ip') {
        const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(v)
        const ipv6 = /^[0-9a-fA-F:]+$/.test(v) && v.includes(':')
        if (!ipv4 && !ipv6) { errors[opt.id] = 'IP inválido (ex: 192.168.0.1)'; ok = false }
      }
      if (opt.paramKind === 'email') {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { errors[opt.id] = 'Endereço inválido'; ok = false }
      }
    }
    setParamErrors(errors)
    return ok
  }

  // Gera o preview real de cada ação marcada (plan_id de verdade, não
  // texto inventado) e só então abre o popup de confirmação — se alguma
  // falhar ao planejar, nenhuma aplica e o popup nem chega a abrir.
  const requestPlans = async () => {
    if (selected.length === 0 || selected.some(capReason)) return
    if (!validateParams()) return
    setPlanningAll(true); setPhase('aguardando')
    const results = []
    for (const opt of selected) {
      try {
        const res = opt.isSuggested
          ? await planIncidentFix(incident.id)
          : await planAction(opt.id, (paramValues[opt.id] || '').trim(), server.id)
        results.push({ opt, plan: res })
      } catch (err) {
        results.push({ opt, plan: null, error: err?.response?.data?.detail || err.message || 'Erro ao planejar.' })
      }
    }
    setPlanningAll(false)
    const failed = results.filter(r => r.error)
    if (failed.length > 0) {
      toast({ type: 'err', msg: `Não deu pra planejar: ${failed.map(r => `${r.opt.label} (${r.error})`).join(' · ')}` })
      setPhase('erro')
      return
    }
    onPhaseChange?.('ocioso')
    setPreviews(results)
  }

  const applyAll = async () => {
    if (!previews) return
    setApplyingAll(true); setPhase('agindo')
    const failures = []
    for (const { opt, plan } of previews) {
      try {
        if (opt.isSuggested) await applyIncidentFix(incident.id, plan.plan_id)
        else await runAction(opt.id, (paramValues[opt.id] || '').trim(), server.id, snapshot, plan.plan_id)
      } catch (err) {
        failures.push(`${opt.label}: ${err?.response?.data?.detail || err.message || 'erro'}`)
      }
    }
    const applied = previews.length - failures.length
    setApplyingAll(false)
    setPreviews(null)
    if (failures.length === 0) {
      toast({ type: 'ok', msg: previews.length === 1 ? `${previews[0].opt.label} concluído.` : `${applied} ações aplicadas com sucesso.` })
      setPhase('concluido')
    } else {
      toast({ type: 'err', msg: `${applied} aplicada(s), falhou: ${failures.join(' · ')}` })
      setPhase('erro')
    }
    onApplied?.()
  }

  if (isResolved) return null

  return (
    <div style={{ background: 'var(--card)', border: '1.5px solid var(--warn-border)', borderRadius: 12, padding: '20px 24px' }}>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>Ações disponíveis</div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.5, marginBottom: 14, whiteSpace: 'pre-wrap' }}>
        {incident.suggested_fix?.description ?? 'Sem orientação registrada — escolha uma ação abaixo ou trate manualmente.'}
      </p>

      {options.length === 0 ? (
        <p style={{ fontSize: 11, color: 'var(--dim)' }}>Nenhuma ação executável de um clique para este tipo de incidente.</p>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
            {options.map(opt => {
              const reason = capReason(opt)
              const isChecked = selectedIds.has(opt.id)
              return (
                <div key={opt.id}>
                  <label
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 9,
                      border: `1.5px solid ${isChecked ? 'var(--sky)' : 'var(--border)'}`,
                      background: isChecked ? 'var(--accent-bg)' : 'var(--surface)',
                      cursor: reason ? 'not-allowed' : 'pointer', opacity: reason ? 0.5 : 1,
                    }}
                  >
                    <input
                      type="checkbox" checked={isChecked} disabled={!!reason}
                      onChange={() => toggle(opt)} style={{ accentColor: 'var(--sky)', flexShrink: 0 }}
                    />
                    <opt.Icon size={13} color={isChecked ? 'var(--accent-fg)' : 'var(--muted)'} style={{ flexShrink: 0 }} />
                    <span style={{ fontSize: 12.5, fontWeight: isChecked ? 600 : 500, color: isChecked ? 'var(--accent-fg)' : 'var(--text)', flex: 1 }}>
                      {opt.label}
                    </span>
                    {opt.isSuggested && (
                      <span style={{
                        fontSize: 9.5, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
                        padding: '2px 7px', borderRadius: 999, background: 'var(--sky)', color: '#fff', flexShrink: 0,
                      }}>
                        Recomendada
                      </span>
                    )}
                    {reason && (
                      <span style={{ fontSize: 10.5, color: 'var(--dim)', flexShrink: 0, maxWidth: 220, textAlign: 'right' }}>{reason}</span>
                    )}
                  </label>
                  {isChecked && opt.hasParam && (
                    <div style={{ marginTop: 6, marginLeft: 30 }}>
                      <input
                        type="text" value={paramValues[opt.id] || ''} placeholder={opt.placeholder || ''}
                        onChange={e => setParamValues(prev => ({ ...prev, [opt.id]: e.target.value }))}
                        style={{
                          width: '100%', boxSizing: 'border-box', borderRadius: 7,
                          border: `1px solid ${paramErrors[opt.id] ? 'var(--danger)' : 'var(--border)'}`,
                          padding: '7px 10px', fontSize: 12.5, color: 'var(--text)', background: 'var(--card)', outline: 'none',
                        }}
                      />
                      {paramErrors[opt.id] && <span style={{ fontSize: 10, color: 'var(--danger)', marginTop: 3, display: 'block' }}>{paramErrors[opt.id]}</span>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {selected.some(o => o.destructive) && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, fontSize: 11.5, color: 'var(--muted)', cursor: 'pointer', userSelect: 'none' }}>
              <input type="checkbox" checked={snapshot} onChange={e => setSnapshot(e.target.checked)} style={{ width: 13, height: 13, accentColor: 'var(--sky)' }} />
              Registrar o estado atual antes de executar (recomendado)
            </label>
          )}

          <Button size="sm" onClick={requestPlans} disabled={selected.length === 0 || planningAll}>
            {planningAll ? 'Gerando plano…' : 'Aplicar plano de correção'}
          </Button>
        </>
      )}

      <Dialog open={!!previews} onOpenChange={(v) => { if (!v && !applyingAll) setPreviews(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirmar plano de correção</DialogTitle>
            <DialogDescription>
              Nada foi alterado ainda — revise {previews?.length === 1 ? 'a ação' : `as ${previews?.length ?? 0} ações`} abaixo antes de aplicar.
            </DialogDescription>
          </DialogHeader>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 320, overflowY: 'auto' }}>
            {previews?.map(({ opt, plan }) => (
              <div key={opt.id} style={{ borderRadius: 9, padding: '10px 12px', background: 'var(--surface)', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>{opt.label}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', whiteSpace: 'pre-wrap' }}>{plan.preview?.message || 'Plano gerado.'}</div>
                {plan.revert_description && (
                  <div style={{ fontSize: 10.5, color: 'var(--dim)', marginTop: 4 }}>
                    <strong>Como reverter:</strong> {plan.revert_description}
                  </div>
                )}
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPreviews(null)} disabled={applyingAll}>Cancelar</Button>
            <Button variant="destructive" size="sm" onClick={applyAll} disabled={applyingAll}>
              {applyingAll ? 'Aplicando…' : 'Confirmar aplicação'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── "Correções aplicadas" — ActionHistory ligada a este incidente
// (incident.actions, novo no detalhe). Diferente da Timeline (que é a
// máquina de estados): aqui é o que um humano mandou executar, com
// resultado real e como reverter.
function AppliedFixes({ actions }) {
  if (!actions || actions.length === 0) return null
  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px' }}>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', marginBottom: 12 }}>Correções aplicadas</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {actions.map((a, i) => (
          <div key={i} style={{
            display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px',
            borderRadius: 9, background: 'var(--surface)', border: '1px solid var(--border)',
          }}>
            {a.success
              ? <CheckCircle2 size={14} color="var(--ok)" style={{ flexShrink: 0, marginTop: 1 }} />
              : <XCircle size={14} color="var(--danger)" style={{ flexShrink: 0, marginTop: 1 }} />}
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
                {ACTION_LABEL[a.action] ?? a.action}
                {a.param && <span style={{ color: 'var(--muted)', fontWeight: 400 }}> · {a.param}</span>}
              </div>
              <div style={{ fontSize: 11, color: 'var(--dim)', marginTop: 2 }}>
                {a.actor} · {fmtDateTime(a.executed_at)}{!a.success && ' · falhou'}
              </div>
              {a.revert_hint && (
                <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 3, fontFamily: "'JetBrains Mono', monospace" }}>
                  reverter: {a.revert_hint}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Coluna esquerda: incidentes ativos + atalho para o Histórico ────────
function IncidentRail({ items, loading, selectedId, historyActive, onPick, onHistory }) {
  return (
    <div className="plano-rail" style={{
      flexShrink: 0, width: 264, alignSelf: 'flex-start', position: 'sticky', top: 76,
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{
        fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 700,
        color: 'var(--dim)', padding: '2px 10px 6px',
      }}>
        Ativos {items.length > 0 && `(${items.length})`}
      </div>

      {loading && items.length === 0 ? (
        <div style={{ padding: '10px 10px', fontSize: 12, color: 'var(--dim)' }}>Carregando…</div>
      ) : items.length === 0 ? (
        <div style={{ padding: '10px 10px', fontSize: 12, color: 'var(--dim)', lineHeight: 1.5 }}>
          Nenhum incidente ativo.
        </div>
      ) : (
        items.map(inc => {
          const sev = SEVERITY_STYLE[inc.severity] ?? SEVERITY_STYLE.atencao
          const active = !historyActive && inc.id === selectedId
          return (
            <button
              key={inc.id}
              onClick={() => onPick(inc.id)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: '9px 10px',
                borderRadius: 9, border: `1px solid ${active ? 'var(--sky)' : 'transparent'}`,
                background: active ? 'var(--accent-bg)' : 'transparent', cursor: 'pointer',
              }}
              onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--surface)' }}
              onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
                <span style={{
                  width: 7, height: 7, borderRadius: '50%', background: sev.text, flexShrink: 0,
                  animation: inc.status === 'aberto' ? 'pulse-sky 1.6s ease-in-out infinite' : undefined,
                }} />
                <span style={{
                  fontSize: 12, fontWeight: active ? 700 : 600,
                  color: active ? 'var(--accent-fg)' : 'var(--text)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  {incidentTitle(inc)}
                </span>
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--dim)', paddingLeft: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {inc.server_name ?? `servidor #${inc.server_id}`}
                {' · '}{STATUS_LABELS[inc.status] ?? inc.status}
                {' · '}{fmtAge(inc.last_seen)}
              </div>
            </button>
          )
        })
      )}

      <div style={{ height: 1, background: 'var(--border)', margin: '8px 10px' }} />

      <button
        onClick={onHistory}
        style={{
          display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
          padding: '9px 10px', borderRadius: 9, cursor: 'pointer',
          border: `1px solid ${historyActive ? 'var(--sky)' : 'transparent'}`,
          background: historyActive ? 'var(--accent-bg)' : 'transparent',
          fontSize: 12, fontWeight: historyActive ? 700 : 600,
          color: historyActive ? 'var(--accent-fg)' : 'var(--muted)',
        }}
        onMouseEnter={e => { if (!historyActive) e.currentTarget.style.background = 'var(--surface)' }}
        onMouseLeave={e => { if (!historyActive) e.currentTarget.style.background = 'transparent' }}
      >
        <History size={13} /> Histórico de planos
      </button>
    </div>
  )
}

// ── Histórico: incidentes resolvidos, abre o plano em modo leitura ──────
function HistoryView({ rows, loading, onOpen }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em', color: 'var(--text)' }}>
          Histórico de planos de correção
        </h2>
        <p style={{ margin: '4px 0 0', fontSize: 12.5, color: 'var(--muted)' }}>
          Incidentes já encerrados — abra qualquer um para ver o plano, o que foi
          executado e a linha do tempo, em modo leitura. Para a auditoria completa
          de toda ação executada em cada servidor, veja{' '}
          <Link to="/settings/history" style={{ color: 'var(--sky)' }}>Configurações → Histórico</Link>.
        </p>
      </div>

      {loading ? (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--dim)', fontSize: 13 }}>Carregando…</div>
      ) : rows.length === 0 ? (
        <div style={{
          background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
          padding: '28px 24px', textAlign: 'center', fontSize: 12.5, color: 'var(--muted)',
        }}>
          Nenhum incidente resolvido ainda.
        </div>
      ) : (
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          {rows.map((inc, i) => {
            const sev = SEVERITY_STYLE[inc.severity] ?? SEVERITY_STYLE.atencao
            const closedAt = inc.resolved_at ?? inc.last_seen
            const how = inc.resolution === 'expirada'
              ? 'resolveu sozinho (parou de ser detectado)'
              : inc.resolution === 'manual'
                ? 'resolvido manualmente'
                : 'encerrado'
            return (
              <button
                key={inc.id}
                onClick={() => onOpen(inc.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, width: '100%', textAlign: 'left',
                  padding: '12px 16px', background: 'none', cursor: 'pointer',
                  border: 'none', borderBottom: i < rows.length - 1 ? '1px solid var(--border)' : 'none',
                }}
                onMouseEnter={e => e.currentTarget.style.background = 'var(--surface)'}
                onMouseLeave={e => e.currentTarget.style.background = 'none'}
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: sev.text, flexShrink: 0 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {incidentTitle(inc)}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--dim)', marginTop: 2 }}>
                    <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{inc.display_id}</span>
                    {' · '}{inc.server_name ?? `servidor #${inc.server_id}`}
                    {' · '}{how}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: 'var(--dim)', flexShrink: 0, textAlign: 'right' }}>
                  {fmtDateTime(closedAt)}
                </div>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Plano completo de UM incidente (o conteúdo antigo da página) ────────
function PlanDetail({ incident, server, onRefresh, actionPhase, setActionPhase }) {
  const toast = useToast()
  const [busy, setBusy] = useState(null)

  const sev = SEVERITY_STYLE[incident.severity] ?? SEVERITY_STYLE.atencao
  const isResolved = incident.status === 'resolvido'

  const events = [...(incident.events ?? [])].sort((a, b) => new Date(a.at) - new Date(b.at))
  const actors = [...new Set(events.map(e => e.actor).filter(a => a && a !== 'system'))]

  const doAck = async () => {
    setBusy('ack')
    try { await ackIncident(incident.id); onRefresh() }
    catch (err) { toast({ type: 'err', msg: err?.response?.data?.detail || 'Erro ao confirmar ciência.' }) }
    finally { setBusy(null) }
  }
  const doSilence = async () => {
    setBusy('silence')
    try { await silenceIncident(incident.id, 60); toast({ type: 'ok', msg: 'Silenciado por 60 minutos.' }); onRefresh() }
    catch (err) { toast({ type: 'err', msg: err?.response?.data?.detail || 'Erro ao silenciar.' }) }
    finally { setBusy(null) }
  }
  const doResolve = async () => {
    setBusy('resolve')
    try { await resolveIncident(incident.id, 'manual'); toast({ type: 'ok', msg: 'Incidente resolvido.' }); onRefresh() }
    catch (err) { toast({ type: 'err', msg: err?.response?.data?.detail || 'Erro ao resolver.' }) }
    finally { setBusy(null) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ── Banner ── */}
      <div style={{
        background: sev.bg, border: `1.5px solid ${sev.border}`, borderRadius: 12,
        padding: '16px 20px', display: 'flex', alignItems: 'flex-start', gap: 14, flexWrap: 'wrap',
      }}>
        {!isResolved && (
          <span style={{
            width: 10, height: 10, borderRadius: '50%', background: sev.text, flexShrink: 0, marginTop: 5,
            animation: 'pulse-sky 1.4s ease-in-out infinite', display: 'block',
          }} />
        )}
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontSize: 15.5, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.01em', marginBottom: 3 }}>
            {incidentTitle(incident)}
          </div>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{incident.display_id}</span>
            {' · '}{incident.server_name ?? `servidor #${incident.server_id}`}
            {' · iniciado às '}{fmtTime(incident.first_seen)}
            {' · '}{STATUS_LABELS[incident.status]}
          </div>
        </div>
        {!isResolved && (
          <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
            <Button size="sm" variant="outline" onClick={doAck} disabled={!!busy}>
              <Check size={12} /> {busy === 'ack' ? 'Confirmando…' : 'Confirmar ciência'}
            </Button>
            <Button size="sm" variant="outline" onClick={doSilence} disabled={!!busy}>
              <ShieldOff size={12} /> {busy === 'silence' ? 'Silenciando…' : 'Silenciar 60min'}
            </Button>
            <Button size="sm" onClick={doResolve} disabled={!!busy}>
              <CheckCircle2 size={12} /> {busy === 'resolve' ? 'Resolvendo…' : 'Resolver'}
            </Button>
          </div>
        )}
      </div>

      {/* ── Causa raiz + Impacto ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }} className="plano-2col">
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>Causa raiz</div>
          <Row label="Servidor" value={`${incident.server_name ?? '—'} (${server?.host ?? '—'})`} mono />
          <Row label="Entidade" value={incident.entity} mono />
          <Row label="Detecção" value={fmtDateTime(incident.first_seen)} mono />
          <Row label="Última confirmação" value={fmtDateTime(incident.last_seen)} mono />
          {incident.triggered_by && (
            <Row label="Regra" value={`${incident.triggered_by.rule} · limite ${String(incident.triggered_by.threshold)} · observado ${String(incident.triggered_by.observed)}`} mono />
          )}
          {incident.unverified_since && (
            <div style={{
              marginTop: 4, padding: '8px 10px', borderRadius: 8, fontSize: 11.5, lineHeight: 1.45,
              background: 'var(--surface)', border: '1px dashed var(--border)', color: 'var(--muted)',
            }}>
              Não foi possível reverificar desde <strong style={{ color: 'var(--text)' }}>{fmtDateTime(incident.unverified_since)}</strong>.
            </div>
          )}
        </div>

        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>Impacto estimado</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <ImpactBox label="Mensagens afetadas" field={incident.impact?.messages_affected} />
            <div style={{ background: 'var(--surface)', borderRadius: 9, padding: '12px 14px' }}>
              <div style={boxLabelStyle}>Tempo em aberto</div>
              <div style={boxValueStyle}>{fmtDuration(incident.impact?.total_open_seconds)}</div>
            </div>
            <ImpactBox
              label="Queda na entrega"
              field={incident.impact?.delivery_rate_impact_pct}
              format={v => (v > 0 ? `-${v} p.p.` : 'sem queda')}
            />
            {incident.impact?.cost_estimate && (
              <div style={{ background: 'var(--warn-bg)', border: '1px solid var(--warn-border)', borderRadius: 9, padding: '12px 14px', gridColumn: 'span 2' }}>
                <div style={{ fontSize: 11.5, color: 'var(--warn)', fontWeight: 700 }}>
                  Custo estimado: R$ {incident.impact.cost_estimate.total_brl.toFixed(2)}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--warn)', opacity: 0.85, marginTop: 2 }}>
                  {incident.impact.cost_estimate.basis}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Stepper (estado real) ── */}
      <Stepper status={incident.status} livePhase={actionPhase} />

      {/* ── Ações disponíveis — escolhe uma opção, plan()→apply() nela ── */}
      <ActionOptions
        key={incident.id}
        incident={incident} server={server} isResolved={isResolved}
        onApplied={onRefresh} onPhaseChange={setActionPhase}
      />

      {/* ── Correções aplicadas (ActionHistory deste incidente) ── */}
      <AppliedFixes actions={incident.actions} />

      {/* ── Responsáveis + Timeline ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }} className="plano-2col">
        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>Quem agiu</div>
          {actors.length === 0 ? (
            <p style={{ fontSize: 12, color: 'var(--dim)' }}>Nenhuma ação humana registrada ainda — só o motor de detecção.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {actors.map(actor => {
                const last = [...events].reverse().find(e => e.actor === actor)
                return (
                  <div key={actor} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--text)', color: 'var(--card)', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                      {initials(actor)}
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{actor}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{EVENT_LABELS[last?.event_type] ?? last?.event_type} · {fmtAge(last?.at)}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>Timeline</div>
          {events.map((e, i) => (
            <div key={i} style={{ display: 'flex', gap: 16, alignItems: 'flex-start', padding: '8px 0', borderBottom: i < events.length - 1 ? '1px solid var(--border)' : 'none' }}>
              <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11.5, color: 'var(--ok)', fontWeight: 600, whiteSpace: 'nowrap', width: 44 }}>
                {fmtTime(e.at)}
              </span>
              <span style={{ fontSize: 12.5, color: 'var(--text)' }}>
                {EVENT_LABELS[e.event_type] ?? e.event_type}
                {e.actor && e.actor !== 'system' && <span style={{ color: 'var(--muted)' }}> · {e.actor}</span>}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function PlanoPage({ view }) {
  const { id: routeId } = useParams()
  const navigate = useNavigate()
  const { search } = useLocation()
  const { servers } = useServer()

  const isHistory = view === 'historico'

  const [activeList, setActiveList] = useState([])
  const [listLoading, setListLoading] = useState(true)
  const [historyRows, setHistoryRows] = useState([])

  const [incident, setIncident] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [actionPhase, setActionPhase] = useState('ocioso')

  const goto = useCallback((path) => navigate(`${path}${search}`), [navigate, search])

  // Lista de todos os incidentes (rail + histórico saem do mesmo fetch —
  // limite padrão 200, mais que suficiente pra uma frota de laboratório).
  const loadList = useCallback(() => {
    fetchIncidents({})
      .then(rows => {
        setActiveList(rows.filter(r => ACTIVE_STATUSES.has(r.status)))
        setHistoryRows(
          rows.filter(r => r.status === 'resolvido')
            .sort((a, b) => new Date(b.resolved_at ?? b.last_seen) - new Date(a.resolved_at ?? a.last_seen))
        )
      })
      .catch(() => { setActiveList([]); setHistoryRows([]) })
      .finally(() => { setListLoading(false) })
  }, [])

  const loadDetail = useCallback((id) => {
    setDetailLoading(true)
    fetchIncident(id)
      .then(d => { setIncident(d); setNotFound(false) })
      .catch(() => { setIncident(null); setNotFound(true) })
      .finally(() => setDetailLoading(false))
  }, [])

  useEffect(() => { loadList() }, [loadList])
  // Poll leve — esta tela fica aberta acompanhando o incidente.
  useEffect(() => {
    const t = setInterval(loadList, 30_000)
    return () => clearInterval(t)
  }, [loadList])

  // Sem :id e não é histórico → manda pro incidente ativo mais severo
  // (crítico antes de atenção, mais recente primeiro). Se não houver
  // nenhum, fica no empty state.
  useEffect(() => {
    if (isHistory || routeId || listLoading) return
    if (activeList.length === 0) { setIncident(null); return }
    const best = [...activeList].sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === 'critico' ? -1 : 1
      return new Date(b.last_seen) - new Date(a.last_seen)
    })[0]
    navigate(`/plano/${best.id}${search}`, { replace: true })
  }, [isHistory, routeId, listLoading, activeList, navigate, search])

  // Carrega/atualiza o detalhe do :id selecionado.
  useEffect(() => {
    if (isHistory || !routeId) { setIncident(null); return }
    loadDetail(Number(routeId))
  }, [isHistory, routeId, loadDetail])

  useEffect(() => {
    if (isHistory || !routeId) return
    const t = setInterval(() => loadDetail(Number(routeId)), 30_000)
    return () => clearInterval(t)
  }, [isHistory, routeId, loadDetail])

  const refresh = useCallback(() => {
    loadList()
    if (routeId) loadDetail(Number(routeId))
  }, [loadList, loadDetail, routeId])

  const selectedId = routeId ? Number(routeId) : null
  const server = incident ? servers.find(s => s.id === incident.server_id) : null

  // Empty state em tela cheia só quando NÃO há nada ativo e não estamos
  // no histórico — aí nem vale desenhar as duas colunas.
  if (!isHistory && !routeId && !listLoading && activeList.length === 0) {
    return <NoActiveIncident />
  }

  return (
    <div style={{
      maxWidth: 1400, margin: '0 auto', padding: '20px 24px 40px', width: '100%',
      display: 'flex', gap: 24, alignItems: 'flex-start',
    }} className="plano-shell">
      <IncidentRail
        items={activeList}
        loading={listLoading}
        selectedId={selectedId}
        historyActive={isHistory}
        onPick={(id) => goto(`/plano/${id}`)}
        onHistory={() => goto('/plano/historico')}
      />

      <div style={{ flex: 1, minWidth: 0 }}>
        {isHistory ? (
          <>
            <button
              onClick={() => goto('/plano')}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 5, marginBottom: 12,
                background: 'none', border: 'none', cursor: 'pointer', color: 'var(--dim)', fontSize: 12, padding: 0,
              }}
            >
              <ChevronLeft size={13} /> Voltar aos ativos
            </button>
            <HistoryView rows={historyRows} loading={listLoading && historyRows.length === 0} onOpen={(id) => goto(`/plano/${id}`)} />
          </>
        ) : detailLoading && !incident ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--dim)', fontSize: 13 }}>Carregando…</div>
        ) : notFound || !incident ? (
          <div style={{
            background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 12,
            padding: '28px 24px', textAlign: 'center', fontSize: 12.5, color: 'var(--muted)',
          }}>
            Incidente não encontrado ou já removido.{' '}
            <button onClick={() => goto('/plano')} style={{ background: 'none', border: 'none', color: 'var(--sky)', cursor: 'pointer', fontSize: 12.5 }}>
              Ver incidentes ativos
            </button>
          </div>
        ) : (
          <PlanDetail
            incident={incident} server={server} onRefresh={refresh}
            actionPhase={actionPhase} setActionPhase={setActionPhase}
          />
        )}
      </div>

      <style>{`
        @media (max-width: 960px) {
          .plano-shell { flex-direction: column; }
          .plano-rail {
            position: static !important; width: 100% !important;
            max-height: 40vh; overflow-y: auto;
          }
          .plano-2col { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  )
}

const boxLabelStyle = { fontSize: 10.5, color: 'var(--dim)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, fontWeight: 600 }
const boxValueStyle = { fontFamily: "'JetBrains Mono', monospace", fontSize: 20, fontWeight: 700, color: 'var(--text)' }

function ImpactBox({ label, field, format = String }) {
  if (!field) return null
  if (!field.estimable) {
    return (
      <div style={{ background: 'var(--surface)', borderRadius: 9, padding: '12px 14px', gridColumn: 'span 2' }}>
        <div style={boxLabelStyle}>{label}</div>
        <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>não estimável</div>
        <div style={{ fontSize: 10, color: 'var(--dim)', marginTop: 2 }}>{field.reason}</div>
      </div>
    )
  }
  return (
    <div style={{ background: 'var(--surface)', borderRadius: 9, padding: '12px 14px' }}>
      <div style={boxLabelStyle}>{label}</div>
      <div style={boxValueStyle}>{format(field.value)}</div>
    </div>
  )
}

function Row({ label, value, mono = false }) {
  if (!value) return null
  return (
    <div style={{ display: 'flex', gap: 10 }}>
      <span style={{ fontSize: 12, color: 'var(--dim)', width: 130, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', fontFamily: mono ? "'JetBrains Mono', monospace" : undefined }}>{value}</span>
    </div>
  )
}
