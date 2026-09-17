import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { UserRole } from '@prisma/client'
import { ArrowLeft } from 'lucide-react'
import { requireUser, roleAtLeast } from '@/lib/auth/guards'
import { loadMovementForm } from '@/lib/services/movement-form'
import { MovementForm, type MovementKind } from './movement-form'
import { PageHeader } from '@/components/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export const metadata: Metadata = { title: 'Record a movement' }

const KINDS: Array<{ kind: MovementKind; label: string; hint: string }> = [
  { kind: 'RECEIVE', label: 'Receive', hint: 'Stock arriving' },
  { kind: 'ISSUE', label: 'Issue', hint: 'Stock leaving' },
  { kind: 'MOVE', label: 'Move', hint: 'Between locations' },
  { kind: 'ADJUST', label: 'Adjust', hint: 'Correct a count' },
  { kind: 'SCRAP', label: 'Scrap', hint: 'Write off' },
]

export default async function NewMovementPage({
  searchParams,
}: {
  searchParams: Promise<{ item?: string; kind?: string; from?: string; qty?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams

  if (!params.item) redirect('/inventory')

  const kind = parseKind(params.kind)
  const siteId = user.defaultSiteId ?? user.siteIds[0]
  if (!siteId) notFound()

  const data = await loadMovementForm(user.db, {
    itemId: params.item,
    siteId,
    fromLocationId: params.from,
    quantity: params.qty ? Number(params.qty) : undefined,
  })
  if (!data) notFound()

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Link
        href={`/inventory/${data.item.id}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {data.item.name}
      </Link>

      <PageHeader title="Record a movement" description={`${data.item.name} · ${data.item.sku}`} />

      <nav className="grid grid-cols-2 gap-2 sm:grid-cols-5" aria-label="Movement type">
        {KINDS.map((option) => (
          <Link
            key={option.kind}
            href={`/movements/new?item=${data.item.id}&kind=${option.kind.toLowerCase()}`}
            aria-current={kind === option.kind ? 'page' : undefined}
            className={cn(
              'rounded-lg border px-3 py-2.5 text-center transition-colors',
              kind === option.kind ? 'border-primary bg-primary/5' : 'hover:bg-accent',
            )}
          >
            <span className="block text-sm font-medium">{option.label}</span>
            <span className="block text-xs text-muted-foreground">{option.hint}</span>
          </Link>
        ))}
      </nav>

      <Card>
        <CardContent className="pt-6">
          <MovementForm
            // Remounts on a type change, so no field carries across from a
            // different kind of movement.
            key={`${kind}-${params.from ?? ''}`}
            kind={kind}
            data={data}
            siteId={siteId}
            isSupervisor={roleAtLeast(user.role, UserRole.SUPERVISOR)}
          />
        </CardContent>
      </Card>
    </div>
  )
}

function parseKind(value: string | undefined): MovementKind {
  const upper = value?.toUpperCase()
  return upper === 'ISSUE' || upper === 'MOVE' || upper === 'ADJUST' || upper === 'SCRAP'
    ? upper
    : 'RECEIVE'
}
