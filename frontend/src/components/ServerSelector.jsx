/**
 * ServerSelector — dropdown no header para trocar o servidor ativo.
 * Aparece apenas quando o usuário tem mais de um servidor.
 */
import { ChevronDown, Server } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useServer } from '../contexts/ServerContext'

const STATUS_DOT = {
  ok:      '#16A34A',
  error:   '#DC2626',
  timeout: '#D97706',
  unknown: '#94A3B8',
}

export default function ServerSelector() {
  const navigate = useNavigate()
  const { servers, activeServer, setActiveServer } = useServer()

  if (!activeServer) return null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="group flex max-w-[200px] flex-shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px] font-medium text-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:border-accent-fg data-[state=open]:bg-accent data-[state=open]:text-accent-foreground"
        >
          <span
            className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
            style={{ background: STATUS_DOT[activeServer.ssh_status] ?? '#94A3B8' }}
          />
          <Server size={11} className="flex-shrink-0" />
          <span className="truncate">{activeServer.name}</span>
          <ChevronDown size={11} className="flex-shrink-0 transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-[220px]">
        {servers.map(s => (
          <DropdownMenuItem
            key={s.id}
            onSelect={() => setActiveServer(s)}
            className={s.id === activeServer.id ? 'bg-accent text-accent-foreground' : ''}
          >
            <span
              className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
              style={{ background: STATUS_DOT[s.ssh_status] ?? '#94A3B8' }}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{s.name}</div>
              <div className="truncate font-mono text-[10px] text-muted">{s.host}:{s.port}</div>
            </div>
            {s.id === activeServer.id && <span className="text-[10px] font-bold text-primary">●</span>}
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/servers')}>
          + Gerenciar servidores
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
