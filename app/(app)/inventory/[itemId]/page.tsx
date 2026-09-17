import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { TrackingMode } from '@prisma/client'
import { ArrowLeft, Plus } from 'lucide-react'
import { requireUser } from '@/lib/auth/guards'
import { itemStock, listBatches } from '@/lib/services/traceability'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { ExpiryBadge } from '@/components/expiry-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ itemId: string }>
}): Promise<Metadata> {
  const user = await requireUser()
  const { itemId } = await params
  const item = await user.db.item.findUnique({ where: { id: itemId }, select: { name: true } })
  return { title: item?.name ?? 'Item' }
}

/**
 * Item detail: where the stock is, broken down the way the item is tracked, plus
 * its ledger history.
 *
 * An untracked item shows one row per location. A batch-tracked item shows one
 * per location AND batch, because "40 in A-01" is not actionable when 12 of them
 * expire next week.
 */
export default async function ItemDetailPage({ params }: { params: Promise<{ itemId: string }> }) {
  const user = await requireUser()
  const { itemId } = await params

  const item = await user.db.item.findFirst({
    where: { id: itemId, deletedAt: null },
    select: {
      id: true,
      sku: true,
      name: true,
      unit: true,
      reorderPoint: true,
      trackingMode: true,
      nearExpiryDays: true,
      category: { select: { name: true } },
      barcodes: { select: { barcode: true, type: true, packSize: true, isPrimary: true } },
    },
  })
  if (!item) notFound()

  const [stock, batches, movements, units] = await Promise.all([
    itemStock(user.db, itemId),
    item.trackingMode === TrackingMode.BATCH ? listBatches(user.db, { itemId }) : [],
    user.db.movement.findMany({
      where: { itemId },
      select: {
        id: true,
        docNo: true,
        type: true,
        quantity: true,
        occurredAt: true,
        note: true,
        fromLocation: { select: { code: true } },
        toLocation: { select: { code: true } },
        user: { select: { name: true } },
      },
      orderBy: { occurredAt: 'desc' },
      take: 25,
    }),
    item.trackingMode === TrackingMode.SERIAL
      ? user.db.serialUnit.findMany({
          where: { itemId },
          select: {
            id: true,
            serialNo: true,
            status: true,
            epc: true,
            location: { select: { code: true } },
          },
          orderBy: { serialNo: 'asc' },
        })
      : [],
  ])

  const onHand = stock.reduce((sum, row) => sum + row.quantity, 0)
  const low = onHand <= item.reorderPoint

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Link
        href="/inventory"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Inventory
      </Link>

      <PageHeader
        title={item.name}
        description={`${item.sku} · ${item.category?.name ?? 'Uncategorised'}`}
        actions={
          <div className="flex items-center gap-4">
            <Button asChild>
              <Link href={`/movements/new?item=${item.id}`}>
                <Plus />
                Record movement
              </Link>
            </Button>
            <div className="text-right">
              <p className="tabular text-2xl font-semibold">{onHand.toLocaleString()}</p>
              <p className="text-xs text-muted-foreground">
                {item.unit} on hand
                {low && (
                  <Badge variant="warn" className="ml-2">
                    Low
                  </Badge>
                )}
              </p>
            </div>
          </div>
        }
      />

      <div className="flex flex-wrap gap-2 text-sm">
        <Badge variant="secondary">
          {item.trackingMode === TrackingMode.NONE
            ? 'Quantity tracked'
            : item.trackingMode === TrackingMode.BATCH
              ? 'Batch tracked'
              : 'Serial tracked'}
        </Badge>
        <Badge variant="outline">Reorder at {item.reorderPoint}</Badge>
        {item.barcodes.map((barcode) => (
          <Badge key={barcode.barcode} variant="outline" className="tabular font-normal">
            {barcode.barcode}
            {barcode.packSize > 1 && ` ×${barcode.packSize}`}
          </Badge>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Stock by location</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {stock.length === 0 ? (
            <EmptyState
              title="No stock on hand"
              hint="Nothing has been received for this item yet."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Location</TableHead>
                  {item.trackingMode !== TrackingMode.NONE && <TableHead>Batch</TableHead>}
                  {item.trackingMode === TrackingMode.BATCH && <TableHead>Expiry</TableHead>}
                  <TableHead className="text-right">Quantity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stock.map((row) => (
                  <TableRow key={`${row.locationId}-${row.batchId ?? 'none'}`}>
                    <TableCell>
                      <span className="tabular font-medium">{row.locationCode}</span>
                      <span className="block text-xs text-muted-foreground">
                        {row.locationName}
                      </span>
                    </TableCell>
                    {item.trackingMode !== TrackingMode.NONE && (
                      <TableCell className="tabular">
                        {row.batchId ? (
                          <Link href={`/batches/${row.batchId}`} className="hover:underline">
                            {row.batchNo}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    )}
                    {item.trackingMode === TrackingMode.BATCH && (
                      <TableCell>
                        <ExpiryBadge
                          state={row.expiryState}
                          daysToExpiry={
                            row.expiryDate
                              ? Math.round((row.expiryDate.getTime() - Date.now()) / 86_400_000)
                              : null
                          }
                          date={row.expiryDate}
                        />
                      </TableCell>
                    )}
                    <TableCell className="tabular text-right font-medium">
                      {row.quantity.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {batches.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Batches</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Batch</TableHead>
                  <TableHead>Expiry</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">On hand</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.map((batch) => (
                  <TableRow key={batch.id}>
                    <TableCell className="tabular">
                      <Link href={`/batches/${batch.id}`} className="font-medium hover:underline">
                        {batch.batchNo}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <ExpiryBadge
                        state={batch.expiryState}
                        daysToExpiry={batch.daysToExpiry}
                        date={batch.expiryDate}
                      />
                    </TableCell>
                    <TableCell>
                      <Badge variant={batch.status === 'ACTIVE' ? 'secondary' : 'destructive'}>
                        {batch.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="tabular text-right">{batch.onHand}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {units.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Units</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Serial</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>RFID tag</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {units.map((unit) => (
                  <TableRow key={unit.id}>
                    <TableCell className="tabular">
                      <Link href={`/serials/${unit.id}`} className="font-medium hover:underline">
                        {unit.serialNo}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={unit.status === 'IN_STOCK' ? 'ok' : 'secondary'}>
                        {unit.status.replace('_', ' ')}
                      </Badge>
                    </TableCell>
                    <TableCell className="tabular">{unit.location?.code ?? '—'}</TableCell>
                    <TableCell className="tabular text-xs text-muted-foreground">
                      {unit.epc ?? 'Not tagged'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Recent movements</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {movements.length === 0 ? (
            <EmptyState title="No movements yet" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Document</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>From / to</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {movements.map((movement) => (
                  <TableRow key={movement.id}>
                    <TableCell className="tabular text-xs">{movement.docNo}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{movement.type}</Badge>
                    </TableCell>
                    <TableCell className="tabular text-sm">
                      {movement.fromLocation?.code ?? '—'} → {movement.toLocation?.code ?? '—'}
                    </TableCell>
                    <TableCell className="tabular text-right">{movement.quantity}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {movement.occurredAt.toISOString().slice(0, 10)}
                      {movement.user && ` · ${movement.user.name}`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
