import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Combina classes condicionais (clsx) e resolve conflitos do Tailwind
 * (tailwind-merge) — padrão shadcn/ui. Usado por todo componente em
 * components/ui e components/primitives.
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs))
}
