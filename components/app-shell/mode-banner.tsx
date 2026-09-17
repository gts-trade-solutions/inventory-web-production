import { FlaskConical } from 'lucide-react'
import type { AppMode } from '@/lib/mode'

/**
 * Demo mode must be unmistakable, including in a screenshot taken out of
 * context. A full-width amber bar plus "DEMO" in the page title means nobody can
 * mistake demo figures for real stock (DEMO_MODE.md §7).
 *
 * Renders nothing in LIVE mode — the normal state should not be decorated.
 */
export function ModeBanner({ mode }: { mode: AppMode }) {
  if (mode !== 'DEMO') return null

  return (
    <div className="flex items-center justify-center gap-2 bg-demo px-4 py-1.5 text-center text-xs font-medium text-demo-foreground">
      <FlaskConical className="size-3.5 shrink-0" />
      <span>Demo mode — sample data and simulated devices. Nothing here affects real stock.</span>
    </div>
  )
}
