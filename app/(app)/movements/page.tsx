import type { Metadata } from 'next'
import Link from 'next/link'
import { MovementType } from '@prisma/client'
import type { Prisma } from '@prisma/client'
import { requireUser } from '@/lib/auth/guards'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export const metadata: Metadata = { title: 'Movements' }

const PAGE_SIZE = 100

/**
 * The ledger.
 *
 * Append-only, so this is a complete record rather than a view of current state:
 * every row is something that happened, attributable to a person, a device and a
 * document number, and none of it can be edited or deleted (WADR-002).
 */
export default async function MovementsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams

  const search = params.q?.trim() ?? ''
  const type = parseType(params.type)

  const where: Prisma.MovementWhereInput = {
    ...(type ? { type } : {}),
    ...(search
      ? {
          OR: [
            { docNo: { contains: search } },
            { reference: { contains: search } },
            { item: { name: { contains: search } } },
            { item: { sku: { contains: search } } },
          ],
        }
      : {}),
  }

  const movements = await user.db.movement.findMany({
    where,
    select: {
      id: true,
      docNo: true,
      type: true,
      quantity: true,
      occurredAt: true,
      reference: true,
      itemId: true,
      item: { select: { sku: true, name: true, unit: true } },
      batch: { select: { id: true, batchNo: true } },
      fromLocation: { select: { code: true } },
      toLocation: { select: { code: true } },
      user: { select: { name: true } },
      device: { select: { label: true } },
      _count: { select: { serials: true } },
    },
    orderBy: { recordedAt: 'desc' },
    take: PAGE_SIZE,
  })

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Movements"
        description="Every stock change ever recorded, newest first. Nothing here can be edited or deleted."
      />

      <form className="mb-4 flex flex-wrap items-center gap-2">
        <Input
          name="q"
          defaultValue={search}
          placeholder="Document number, reference, item or SKU…"
          aria-label="Search movements"
          className="max-w-sm"
        />
        {Object.values(MovementType).map((option) => (
          <Link
            key={option}
            href={buildHref({
              q: search,
              type: type === option ? undefined : option.toLowerCase(),
            })}
            className={
              type === option
                ? 'rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground'
                : 'rounded-md border px-3 py-2 text-sm hover:bg-accent'
            }
          >
            {option}
          </Link>
        ))}
      </form>

      <div className="rounded-lg border bg-card">
        {movements.length === 0 ? (
          <EmptyState
            title="No movements match"
            hint={
              search || type ? 'Try clearing the search or the filter.' : 'No stock has moved yet.'
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Batch / units</TableHead>
                <TableHead>From / to</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead>When</TableHead>
                <TableHead>By</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {movements.map((movement) => (
                <TableRow key={movement.id}>
                  <TableCell className="tabular text-xs">
                    {movement.docNo}
                    {movement.reference && (
                      <span className="block text-muted-foreground">{movement.reference}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={badgeFor(movement.type)}>{movement.type}</Badge>
                  </TableCell>
                  <TableCell>
                    <Link href={`/inventory/${movement.itemId}`} className="hover:underline">
                      {movement.item.name}
                    </Link>
                    <span className="tabular block text-xs text-muted-foreground">
                      {movement.item.sku}
                    </span>
                  </TableCell>
                  <TableCell className="tabular text-sm">
                    {movement.batch ? (
                      <Link href={`/batches/${movement.batch.id}`} className="hover:underline">
                        {movement.batch.batchNo}
                      </Link>
                    ) : movement._count.serials > 0 ? (
                      <span className="text-muted-foreground">
                        {movement._count.serials} unit{movement._count.serials === 1 ? '' : 's'}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="tabular text-sm">
                    {movement.fromLocation?.code ?? '—'} → {movement.toLocation?.code ?? '—'}
                  </TableCell>
                  <TableCell className="tabular text-right font-medium">
                    {movement.quantity}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      {movement.item.unit}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {movement.occurredAt.toISOString().slice(0, 10)}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {movement.user?.name ?? '—'}
                    {movement.device && (
                      <span className="block text-xs">{movement.device.label}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      {movements.length === PAGE_SIZE && (
        <p className="mt-3 text-xs text-muted-foreground">
          Showing the {PAGE_SIZE} most recent. Paging and export arrive with Phase 3.
        </p>
      )}
    </div>
  )
}

function badgeFor(type: MovementType) {
  if (type === MovementType.RECEIVE) return 'ok' as const
  if (type === MovementType.SCRAP) return 'destructive' as const
  if (type === MovementType.ADJUST || type === MovementType.COUNT) return 'warn' as const
  return 'outline' as const
}

function buildHref(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value)
  }
  const string = query.toString()
  return string ? `/movements?${string}` : '/movements'
}

function parseType(value: string | undefined): MovementType | undefined {
  const upper = value?.toUpperCase()
  return upper && upper in MovementType ? (upper as MovementType) : undefined
}
