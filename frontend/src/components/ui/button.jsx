import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium ' +
  'transition-colors disabled:pointer-events-none disabled:opacity-50 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card ' +
  '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:     'border border-transparent bg-primary text-primary-foreground shadow-sm hover:brightness-95 active:brightness-90',
        secondary:   'border border-border bg-surface text-foreground hover:bg-accent hover:text-accent-foreground',
        outline:     'border border-border bg-card text-muted hover:bg-accent hover:text-accent-foreground',
        ghost:       'border border-transparent bg-transparent text-muted hover:bg-accent hover:text-accent-foreground',
        destructive: 'border border-destructive-border bg-destructive-bg text-destructive hover:brightness-95 active:brightness-90',
        link:        'border-none text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 text-[13px]',
        sm:      'h-7 px-3 text-[11px] gap-1.5',
        lg:      'h-11 px-5 text-[13px]',
        icon:    'h-8 w-8 p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

const Button = React.forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button'
  return (
    <Comp
      className={cn(buttonVariants({ variant, size, className }))}
      ref={ref}
      {...props}
    />
  )
})
Button.displayName = 'Button'

export { Button, buttonVariants }
