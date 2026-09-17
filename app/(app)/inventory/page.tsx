import type { Metadata } from 'next'
import Link from 'next/link'
import { TrackingMode, UserRole } from '@prisma/client'
import type { Prisma } from '@prisma/client'
import { Layers, Package, Plus, ScanBarcode } from 'lucide-react'
import { requireUser, roleAtLeast } from '@/lib/auth/guards'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export const metadata: Metadata = { title: 'Inventory' }

const PAGE_SIZE = 50

/**
 * The item list.
 *
 * Search and filtering happen in SQL, not in the browser: a warehouse with
 * 20,000 SKUs cannot ship the catalogue to the client and filter it there, and
 * building it that way now means rewriting it later.
 */
export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; tracking?: string; low?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams

  const search = params.q?.trim() ?? ''
  const tracking = parseTracking(params.tracking)
  const lowOnly = params.low === '1'

  const where: Prisma.ItemWhereInput = {
    deletedAt: null,
    ...(tracking ? { trackingMode: tracking } : {}),
    ...(search
      ? {
          OR: [
            { name: { contains: search } },
            { sku: { contains: search } },
            { barcodes: { some: { barcode: { contains: search } } } },
          ],
        }
      : {}),
  }

  const items = await user.db.item.findMany({
    where,
    select: {
      id: true,
      sku: true,
      name: true,
      unit: true,
      reorderPoint: true,
      trackingMode: true,
      category: { select: { name: true } },
      stockLevels: { select: { quantity: true } },
      _count: { select: { batches: true, serialUnits: true } },
    },
    orderBy: { name: 'asc' },
    take: PAGE_SIZE,
  })

  const rows = items
    .map((item) => ({
      ...item,
      onHand: item.stockLevels.reduce((sum, level) => sum + level.quantity, 0),
    }))
    // Low stock is derived per item, so it is filtered after the projection sum
    // rather than in SQL. At page size it costs nothing; a dedicated index-backed
    // column arrives if the list ever outgrows it.
    .filter((item) => !lowOnly || item.onHand <= item.reorderPoint)

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Inventory"
        description={`${rows.length} item${rows.length === 1 ? '' : 's'}${
          search ? ` matching “${search}”` : ''
        }`}
        actions={
          roleAtLeast(user.role, UserRole.ADMIN) ? (
            <Button asChild>
              <Link href="/inventory/new">
                <Plus />
                New item
              </Link>
            </Button>
          ) : null
        }
      />

      <form className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <ScanBarcode className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            name="q"
            defaultValue={search}
            placeholder="Search name, SKU or barcode…"
            className="pl-9"
            aria-label="Search inventory"
          />
        </div>

        <FilterLink
          href={buildHref({ q: search, low: lowOnly ? undefined : '1', tracking: params.tracking })}
          active={lowOnly}
        >
          Low stock
        </FilterLink>

        {[TrackingMode.BATCH, TrackingMode.SERIAL].map((mode) => (
          <FilterLink
            key={mode}
            href={buildHref({
              q: search,
              low: lowOnly ? '1' : undefined,
              tracking: tracking === mode ? undefined : mode.toLowerCase(),
            })}
            active={tracking === mode}
          >
            {mode === TrackingMode.BATCH ? 'Batch-tracked' : 'Serial-tracked'}
          </FilterLink>
        ))}
      </form>

      <div className="rounded-lg border bg-card">
        {rows.length === 0 ? (
          <EmptyState
            title="No items match"
            hint={
              search || lowOnly || tracking
                ? 'Try a broader search or clear the filters.'
                : 'No items have been created yet.'
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Tracking</TableHead>
                <TableHead className="text-right">On hand</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((item) => {
                const low = item.onHand <= item.reorderPoint

                return (
                  <TableRow key={item.id}>
                    <TableCell>
                      <Link href={`/inventory/${item.id}`} className="group block">
                        <span className="font-medium group-hover:underline">{item.name}</span>
                        <span className="tabular block text-xs text-muted-foreground">
                          {item.sku}
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {item.category?.name ?? '—'}
                    </TableCell>
                    <TableCell>
                      <TrackingCell mode={item.trackingMode} counts={item._count} />
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="tabular font-medium">{item.onHand.toLocaleString()}</span>
                      <span className="ml-1 text-xs text-muted-foreground">{item.unit}</span>
                      {low && (
                        <Badge variant="warn" className="ml-2">
                          Low
                        </Badge>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {items.length === PAGE_SIZE && (
        <p className="mt-3 text-xs text-muted-foreground">
          Showing the first {PAGE_SIZE}. Paging arrives with Phase 3.
        </p>
      )}
    </div>
  )
}

function TrackingCell({
  mode,
  counts,
}: {
  mode: TrackingMode
  counts: { batches: number; serialUnits: number }
}) {
  if (mode === TrackingMode.BATCH) {
    return (
      <span className="flex items-center gap-1.5 text-sm">
        <Layers className="size-3.5 text-muted-foreground" />
        {counts.batches} batch{counts.batches === 1 ? '' : 'es'}
      </span>
    )
  }

  if (mode === TrackingMode.SERIAL) {
    return (
      <span className="flex items-center gap-1.5 text-sm">
        <Package className="size-3.5 text-muted-foreground" />
        {counts.serialUnits} unit{counts.serialUnits === 1 ? '' : 's'}
      </span>
    )
  }

  return <span className="text-sm text-muted-foreground">Quantity only</span>
}

function FilterLink({
  href,
  active,
  children,
}: {
  href: string
  active: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      className={
        active
          ? 'rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground'
          : 'rounded-md border px-3 py-2 text-sm hover:bg-accent'
      }
    >
      {children}
    </Link>
  )
}

function buildHref(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value)
  }
  const string = query.toString()
  return string ? `/inventory?${string}` : '/inventory'
}

function parseTracking(value: string | undefined): TrackingMode | undefined {
  const upper = value?.toUpperCase()
  return upper === 'BATCH' || upper === 'SERIAL' || upper === 'NONE'
    ? (upper as TrackingMode)
    : undefined
}
