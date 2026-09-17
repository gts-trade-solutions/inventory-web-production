import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, MapPin } from 'lucide-react'
import { requireUser } from '@/lib/auth/guards'
import { traceBatch } from '@/lib/services/traceability'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { ExpiryBadge } from '@/components/expiry-badge'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export const metadata: Metadata = { title: 'Batch' }

/**
 * The recall pack for one batch.
 *
 * Answers the question a quality incident actually asks — where did this lot go?
 * — in one view: everywhere its stock currently sits, every movement it has ever
 * been part of, and every unit it produced.
 */
export default async function BatchDetailPage({
  params,
}: {
  params: Promise<{ batchId: string }>
}) {
  const user = await requireUser()
  const { batchId } = await params

  const trace = await traceBatch(user.db, batchId)
  if (!trace) notFound()

  const { batch, locations, movements, units } = trace

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Link
        href="/batches"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Batches
      </Link>

      <PageHeader
        title={batch.batchNo}
        description={`${batch.itemName} · ${batch.itemSku}`}
        actions={
          <div className="text-right">
            <p className="tabular text-2xl font-semibold">{batch.onHand.toLocaleString()}</p>
            <p className="text-xs text-muted-foreground">{batch.unit} on hand</p>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <ExpiryBadge
          state={batch.expiryState}
          daysToExpiry={batch.daysToExpiry}
          date={batch.expiryDate}
        />
        <Badge variant={batch.status === 'ACTIVE' ? 'secondary' : 'destructive'}>
          {batch.status}
        </Badge>
        {batch.supplierRef && <Badge variant="outline">Supplier {batch.supplierRef}</Badge>}
        <Link href={`/inventory/${batch.itemId}`}>
          <Badge variant="outline">View item</Badge>
        </Link>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Where it is now</CardTitle>
          <CardDescription>
            Every location still holding stock from this batch. This is the pick list for a recall.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {locations.length === 0 ? (
            <EmptyState
              title="None left in stock"
              hint="Every unit from this batch has been issued or scrapped. The history below shows where it went."
              icon={<MapPin className="size-8" />}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Location</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {locations.map((location) => (
                  <TableRow key={location.locationId}>
                    <TableCell>
                      <span className="tabular font-medium">{location.code}</span>
                      <span className="block text-xs text-muted-foreground">{location.name}</span>
                    </TableCell>
                    <TableCell className="tabular text-right font-medium">
                      {location.quantity.toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {units.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Units from this batch</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Serial</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Location</TableHead>
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
                    <TableCell className="tabular">{unit.location ?? '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Full history</CardTitle>
          <CardDescription>
            Every movement this batch has been part of, newest first.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {movements.length === 0 ? (
            <EmptyState title="No movements recorded" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Document</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>From / to</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>By</TableHead>
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
                      {movement.from ?? '—'} → {movement.to ?? '—'}
                    </TableCell>
                    <TableCell className="tabular text-right">{movement.quantity}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {movement.occurredAt.toISOString().slice(0, 10)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {movement.user ?? '—'}
                      {movement.device && ` · ${movement.device}`}
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
