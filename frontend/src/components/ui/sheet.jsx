import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { cva } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const Sheet = DialogPrimitive.Root
const SheetTrigger = DialogPrimitive.Trigger
const SheetClose = DialogPrimitive.Close
const SheetPortal = DialogPrimitive.Portal
const SheetTitle = DialogPrimitive.Title

const SheetOverlay = React.forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-40 bg-[rgba(15,23,42,0.35)] backdrop-blur-[2px]',
      'data-[state=open]:animate-in data-[state=closed]:animate-out',
      'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className
    )}
    {...props}
  />
))
SheetOverlay.displayName = DialogPrimitive.Overlay.displayName

const sheetVariants = cva(
  'fixed z-50 flex flex-col bg-card text-foreground outline-none ' +
  'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-150',
  {
    variants: {
      side: {
        right:
          'inset-y-0 right-0 h-full border-l border-border shadow-[-4px_0_32px_rgba(0,0,0,0.10)] ' +
          'data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right',
      },
    },
    defaultVariants: { side: 'right' },
  }
)

// Sheet lateral (drawer) — usado para painéis de detalhe/log que antes eram
// implementados à mão (backdrop + div fixa + <style> com @keyframes locais).
// Radix Dialog cobre de graça: foco preso, Esc, clique fora, aria-*.
const SheetContent = React.forwardRef(
  ({ side, className, style, children, ...props }, ref) => (
    <SheetPortal>
      <SheetOverlay />
      <DialogPrimitive.Content
        ref={ref}
        style={style}
        className={cn(sheetVariants({ side }), className)}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </SheetPortal>
  )
)
SheetContent.displayName = DialogPrimitive.Content.displayName

export { Sheet, SheetTrigger, SheetClose, SheetPortal, SheetOverlay, SheetContent, SheetTitle }
