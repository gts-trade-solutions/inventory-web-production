import type { Metadata } from 'next'
import Link from 'next/link'
import { SerialStatus } from '@prisma/client'
import type { Prisma } from '@prisma/client'
import { Radio } from 'lucide-react'
import { requireUser } from '@/lib/auth/guards'
import { isEpc } from '@/lib/domain/sgtin96'
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

export const metadata: Metadata = { title: 'Serial units' }

const PAGE_SIZE = 100

/**
 * The serial unit register.
 *
 * The search accepts a scanned RFID tag as readily as a typed serial number: an
 * operator holding a reader has the EPC, not the serial, and making them
 * translate it by hand would waste the whole point of tagging the unit.
 */
export default async function SerialsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams

  const search = params.q?.trim() ?? ''
  const status = parseStatus(params.status)
  const searchIsEpc = isEpc(search)

  const where: Prisma.SerialUnitWhereInput = {
    ...(status ? { status } : {}),
    ...(search
      ? searchIsEpc
        ? { epc: search.toUpperCase() }
        : {
            OR: [
              { serialNo: { contains: search } },
              { item: { name: { contains: search } } },
              { item: { sku: { contains: search } } },
              { batch: { batchNo: { contains: search } } },
            ],
          }
      : {}),
  }

  const units = await user.db.serialUnit.findMany({
    where,
    select: {
      id: true,
      serialNo: true,
      epc: true,
      status: true,
      itemId: true,
      item: { select: { sku: true, name: true } },
      batch: { select: { id: true, batchNo: true } },
      location: { select: { code: true } },
    },
    orderBy: [{ item: { sku: 'asc' } }, { serialNo: 'asc' }],
    take: PAGE_SIZE,
  })

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Serial units"
        description="Individually tracked units. Search by serial, item, batch — or paste a scanned RFID tag."
      />

      <form className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-64 flex-1">
          <Radio className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            name="q"
            defaultValue={search}
            placeholder="Serial, item, batch or EPC…"
            className="pl-9"
            aria-label="Search serial units"
          />
        </div>

        {[SerialStatus.IN_STOCK, SerialStatus.ISSUED].map((option) => (
          <Link
            key={option}
            href={buildHref({
              q: search,
              status: status === option ? undefined : option.toLowerCase(),
            })}
            className={
              status === option
                ? 'rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground'
                : 'rounded-md border px-3 py-2 text-sm hover:bg-accent'
            }
          >
            {option === SerialStatus.IN_STOCK ? 'In stock' : 'Issued'}
          </Link>
        ))}
      </form>

      {searchIsEpc && (
        <p className="mb-3 text-sm text-muted-foreground">
          Looking up RFID tag <span className="tabular">{search.toUpperCase()}</span>.
        </p>
      )}

      <div className="rounded-lg border bg-card">
        {units.length === 0 ? (
          <EmptyState
            title={searchIsEpc ? 'No unit carries that tag' : 'No units match'}
            hint={
              searchIsEpc
                ? 'The tag is a valid EPC but is not on record — it may belong to another site, or to stock never received here.'
                : 'Try a broader search, or clear the status filter.'
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Serial</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Batch</TableHead>
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
                    <Link href={`/inventory/${unit.itemId}`} className="hover:underline">
                      {unit.item.name}
                    </Link>
                    <span className="tabular block text-xs text-muted-foreground">
                      {unit.item.sku}
                    </span>
                  </TableCell>
                  <TableCell className="tabular">
                    {unit.batch ? (
                      <Link href={`/batches/${unit.batch.id}`} className="hover:underline">
                        {unit.batch.batchNo}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={unit.status === SerialStatus.IN_STOCK ? 'ok' : 'secondary'}>
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
        )}
      </div>
    </div>
  )
}

function buildHref(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value)
  }
  const string = query.toString()
  return string ? `/serials?${string}` : '/serials'
}

function parseStatus(value: string | undefined): SerialStatus | undefined {
  const upper = value?.toUpperCase()
  return upper && upper in SerialStatus ? (upper as SerialStatus) : undefined
}
