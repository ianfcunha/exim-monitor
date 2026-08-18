import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

/**
 * Composição label + hint + input + erro — unifica o padrão que hoje
 * está duplicado (com pequenas variações) em Login, ServersPage,
 * Settings e UsersPage.
 */
export function Field({ label, htmlFor, hint, error, required, className, children }) {
  return (
    <div className={cn('mb-3.5', className)}>
      {label && (
        <Label htmlFor={htmlFor}>
          {label}
          {required && <span className="ml-0.5 text-destructive">*</span>}
        </Label>
      )}
      {hint && <p className="mb-1.5 text-[11px] text-dim">{hint}</p>}
      {children}
      {error && <p className="mt-1 text-[11px] text-destructive">{error}</p>}
    </div>
  )
}
