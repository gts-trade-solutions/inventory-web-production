import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, Radio } from 'lucide-react'
import { requireUser } from '@/lib/auth/guards'
import { traceSerialUnit } from '@/lib/services/traceability'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export const metadata: Metadata = { title: 'Serial unit' }

/**
 * The life of one physical unit.
 *
 * Shown as a timeline rather than a table, because the question is "what
 * happened to this thing?" — a sequence, not a set of rows to scan.
 *
 * The EPC is the link to RFID: an antenna reading that tag resolves to exactly
 * this record, which is what makes a cycle count report missing UNITS rather
 * than a missing quantity (ARCHITECTURE §5.4).
 */
export default async function SerialDetailPage({
  params,
}: {
  params: Promise<{ unitId: string }>
}) {
  const user = await requireUser()
  const { unitId } = await params

  const trace = await traceSerialUnit(user.db, unitId)
  if (!trace) notFound()

  const { unit, history } = trace

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link
        href={`/inventory/${unit.itemId}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {unit.itemName}
      </Link>

      <PageHeader
        title={unit.serialNo}
        description={`${unit.itemName} · ${unit.itemSku}`}
        actions={
          <Badge variant={unit.status === 'IN_STOCK' ? 'ok' : 'secondary'}>
            {unit.status.replace('_', ' ')}
          </Badge>
        }
      />

      <Card>
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
          <Field label="Current location" value={unit.location ?? 'Not in stock'} mono />
          <Field
            label="Batch"
            value={unit.batchNo ?? 'Not batch tracked'}
            mono
            href={unit.batchId ? `/batches/${unit.batchId}` : undefined}
          />
          <Field label="Received" value={unit.receivedAt.toISOString().slice(0, 10)} mono />
          <Field
            label="Issued"
            value={unit.issuedAt ? unit.issuedAt.toISOString().slice(0, 10) : 'Still held'}
            mono
          />
          <div className="sm:col-span-2">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              RFID tag (SGTIN-96)
            </p>
            <p className="tabular mt-1 flex items-center gap-2 text-sm">
              {unit.epc ? (
                <>
                  <Radio className="size-3.5 text-muted-foreground" />
                  {unit.epc}
                </>
              ) : (
                <span className="text-muted-foreground">Not tagged</span>
              )}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Life history</CardTitle>
          <CardDescription>
            Every movement this unit has been part of, oldest first.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <EmptyState
              title="No movements recorded"
              hint="This unit was created without a receipt, which usually means it came from an import."
            />
          ) : (
            <ol className="relative space-y-5 border-l pl-6">
              {history.map((entry, index) => (
                <li key={`${entry.docNo}-${index}`} className="relative">
                  <span className="absolute -left-[1.6875rem] top-1.5 size-3 rounded-full border-2 border-background bg-primary" />
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Badge variant="outline">{entry.type}</Badge>
                    <span className="tabular text-xs text-muted-foreground">{entry.docNo}</span>
                    <span className="text-xs text-muted-foreground">
                      {entry.occurredAt.toISOString().slice(0, 10)}
                    </span>
                  </div>
                  <p className="tabular mt-1 text-sm">
                    {entry.from ?? 'Outside'} → {entry.to ?? 'Issued out'}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {entry.user ?? 'Unknown user'}
                    {entry.device && ` · ${entry.device}`}
                    {entry.note && ` · ${entry.note}`}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Field({
  label,
  value,
  mono,
  href,
}: {
  label: string
  value: string
  mono?: boolean
  href?: string
}) {
  const body = <p className={mono ? 'tabular mt-1 text-sm' : 'mt-1 text-sm'}>{value}</p>

  return (
    <div>
      <p className="text-xs uppercase tracking-wider text-muted-foreground">{label}</p>
      {href ? (
        <Link href={href} className="hover:underline">
          {body}
        </Link>
      ) : (
        body
      )}
    </div>
  )
}
