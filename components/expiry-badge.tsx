import { Badge } from '@/components/ui/badge'
import type { ExpiryState } from '@/lib/services/traceability'

/**
 * Expiry at a glance.
 *
 * Shows the number of days as well as the state, because "expired" and "expired
 * 6 days ago" prompt different actions, and an operator should not have to
 * subtract dates on a warehouse floor.
 */
export function ExpiryBadge({
  state,
  daysToExpiry,
  date,
}: {
  state: ExpiryState
  daysToExpiry: number | null
  date?: Date | null
}) {
  if (state === 'NONE') return <span className="text-muted-foreground">—</span>

  const iso = date ? date.toISOString().slice(0, 10) : null

  if (state === 'EXPIRED') {
    return (
      <Badge variant="destructive" title={iso ?? undefined}>
        Expired {daysToExpiry !== null ? `${Math.abs(daysToExpiry)}d ago` : ''}
      </Badge>
    )
  }

  if (state === 'NEAR') {
    return (
      <Badge variant="warn" title={iso ?? undefined}>
        {daysToExpiry}d left
      </Badge>
    )
  }

  return <span className="tabular text-muted-foreground">{iso}</span>
}
