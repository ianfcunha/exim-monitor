import * as React from 'react'
import { cn } from '@/lib/utils'

const Input = React.forwardRef(({ className, type = 'text', ...props }, ref) => {
  return (
    <input
      type={type}
      ref={ref}
      className={cn(
        'flex h-9 w-full rounded-md border border-border bg-surface px-3.5 text-[12px] text-foreground',
        'outline-none transition-colors placeholder:text-dim',
        'focus-visible:border-primary focus-visible:ring-1 focus-visible:ring-primary',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive',
        className
      )}
      {...props}
    />
  )
})
Input.displayName = 'Input'

export { Input }
