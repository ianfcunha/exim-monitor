/**
 * ServerSelector — seletor de servidor/frota do cabeçalho.
 *
 * Sessão 4, Tarefa 8: ganhou a opção "Toda a frota" e passou a existir
 * em TODAS as telas (vive na casca, ver AppShell.jsx), não só no painel
 * clássico. A seleção é global e mora na URL — ver ServerContext.
 */
import { ChevronDown, Layers, Server } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useServer } from '../contexts/ServerContext'

const STATUS_DOT = {
  ok:      'var(--ok)',
  error:   'var(--danger)',
  timeout: 'var(--warn)',
  unknown: 'var(--dim)',
}

export default function ServerSelector({ allowFleet = true }) {
  const navigate = useNavigate()
  const { servers, activeServer, isFleet, setActiveServer } = useServer()

  if (servers.length === 0) return null

  const showingFleet = allowFleet && isFleet

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="group flex max-w-[220px] flex-shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px] font-medium text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:border-accent-fg data-[state=open]:bg-accent data-[state=open]:text-accent-foreground"
        >
          {showingFleet ? (
            <>
              <Layers size={11} className="flex-shrink-0" />
              <span className="truncate">Toda a frota</span>
              <span className="flex-shrink-0 text-[10px] text-muted">({servers.length})</span>
            </>
          ) : (
            <>
              <span
                className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                style={{ background: STATUS_DOT[activeServer?.ssh_status] ?? 'var(--dim)' }}
              />
              <Server size={11} className="flex-shrink-0" />
              <span className="truncate">{activeServer?.name ?? 'Selecionar servidor'}</span>
            </>
          )}
          <ChevronDown size={11} className="flex-shrink-0 transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-[240px]">
        {allowFleet && (
          <>
            <DropdownMenuItem
              onSelect={() => setActiveServer(null)}
              className={showingFleet ? 'bg-accent text-accent-foreground' : ''}
            >
              <Layers size={12} className="flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">Toda a frota</div>
                <div className="truncate text-[10px] text-muted">
                  {servers.length} servidor{servers.length === 1 ? '' : 'es'}
                </div>
              </div>
              {showingFleet && <span className="text-[10px] font-bold text-primary">●</span>}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}

        {servers.map(s => (
          <DropdownMenuItem
            key={s.id}
            onSelect={() => setActiveServer(s)}
            className={!showingFleet && s.id === activeServer?.id ? 'bg-accent text-accent-foreground' : ''}
          >
            <span
              className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
              style={{ background: STATUS_DOT[s.ssh_status] ?? 'var(--dim)' }}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{s.name}</div>
              <div className="truncate font-mono text-[10px] text-muted">{s.host}:{s.port}</div>
            </div>
            {!showingFleet && s.id === activeServer?.id && <span className="text-[10px] font-bold text-primary">●</span>}
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/settings/servers')}>
          + Gerenciar servidores
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
