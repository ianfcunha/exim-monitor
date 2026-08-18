import * as React from 'react'
import { cn } from '@/lib/utils'

const Label = React.forwardRef(({ className, ...props }, ref) => (
  <label
    ref={ref}
    className={cn(
      'mb-1.5 block text-[12px] font-semibold tracking-wide text-muted',
      'peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
      className
    )}
    {...props}
  />
))
Label.displayName = 'Label'

export { Label }
