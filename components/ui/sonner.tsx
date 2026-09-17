'use client'

import { Toaster as Sonner } from 'sonner'

export function Toaster() {
  return (
    <Sonner
      // Warehouse screens are often across the room; bottom-right at this size
      // is legible without covering the working area.
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast: 'bg-card text-card-foreground border border-border shadow-lg',
          description: 'text-muted-foreground',
        },
      }}
    />
  )
}
