import { PackageOpen } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Empty is not an error. It usually means a filter is too narrow or the work has
 * not happened yet, so the message says which.
 */
export function EmptyState({
  title,
  hint,
  icon,
  className,
}: {
  title: string
  hint?: string
  icon?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center gap-2 px-4 py-12 text-center', className)}>
      <div className="text-muted-foreground/60">{icon ?? <PackageOpen className="size-8" />}</div>
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="max-w-sm text-sm text-muted-foreground">{hint}</p>}
    </div>
  )
}
