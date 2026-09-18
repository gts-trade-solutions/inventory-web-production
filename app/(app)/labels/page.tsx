import type { Metadata } from 'next'
import Link from 'next/link'
import { DeviceKind, PrintJobStatus } from '@prisma/client'
import { requireUser } from '@/lib/auth/guards'
import { listPrintJobs } from '@/lib/services/printing'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { LabelStudio } from './label-studio'

export const metadata: Metadata = { title: 'Labels & printing' }

/**
 * Printing labels, and the record of every one printed.
 *
 * The history is not a nicety. Every RFID label carries an EPC that identifies
 * one physical unit, so the print record is the only link between a tag in the
 * world and the unit it was meant for (ARCHITECTURE §5.4).
 */
export default async function LabelsPage({
  searchParams,
}: {
  searchParams: Promise<{ item?: string; batch?: string }>
}) {
  const user = await requireUser()
  const params = await searchParams

  const [templates, printers, items, batches, locations, jobs] = await Promise.all([
    user.db.labelTemplate.findMany({
      where: { active: true },
      select: { id: true, name: true, kind: true, rfidEncode: true, widthMm: true, heightMm: true },
      orderBy: { name: 'asc' },
    }),
    user.db.device.findMany({
      where: { kind: DeviceKind.PRINTER, active: true },
      select: { id: true, label: true, connection: true, address: true },
      orderBy: { label: 'asc' },
    }),
    user.db.item.findMany({
      where: { active: true, deletedAt: null },
      select: { id: true, sku: true, name: true },
      orderBy: { sku: 'asc' },
      take: 300,
    }),
    user.db.batch.findMany({
      select: { id: true, batchNo: true, itemId: true },
      orderBy: { batchNo: 'asc' },
      take: 300,
    }),
    user.db.location.findMany({
      where: { active: true, deletedAt: null },
      select: { id: true, code: true, name: true },
      orderBy: { code: 'asc' },
    }),
    listPrintJobs(user.db, { limit: 25 }),
  ])

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title="Labels & printing"
        description="Print item, batch and location labels — and see exactly what will come out before it does."
      />

      {templates.length === 0 ? (
        <EmptyState
          title="No label templates yet"
          hint="Templates live in the database rather than in code, so a label can be changed without a release. An administrator adds them."
        />
      ) : (
        <LabelStudio
          templates={templates}
          printers={printers.map((printer) => ({
            id: printer.id,
            label: printer.label,
            simulated: printer.connection === 'SIMULATED' || !printer.address,
          }))}
          items={items}
          batches={batches}
          locations={locations}
          selectedItemId={params.item ?? null}
          selectedBatchId={params.batch ?? null}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent print jobs</CardTitle>
          <p className="text-sm text-muted-foreground">
            Every label printed, and the tag it encoded. This is what links a tag in the world back
            to the unit it belongs to.
          </p>
        </CardHeader>
        <CardContent>
          {jobs.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing has been printed yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Document</TableHead>
                  <TableHead>Label</TableHead>
                  <TableHead>For</TableHead>
                  <TableHead>Printer</TableHead>
                  <TableHead>Tag</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell className="tabular">{job.docNo}</TableCell>
                    <TableCell>{job.template.name}</TableCell>
                    <TableCell>
                      {job.item ? (
                        <>
                          <span>{job.item.name}</span>
                          <span className="tabular block text-xs text-muted-foreground">
                            {job.item.sku}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">{job.printerDevice?.label ?? '—'}</TableCell>
                    <TableCell className="tabular text-xs text-muted-foreground">
                      {job.epc ?? '—'}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={job.status} error={job.error} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        Printers are registered under{' '}
        <Link href="/devices" className="underline">
          Devices
        </Link>
        .
      </p>
    </div>
  )
}

/**
 * SENT is not PRINTED.
 *
 * A networked printer takes the bytes and closes the socket; that tells us it
 * accepted the job, not that a label came out. Showing "Printed" would send
 * somebody looking for a label that may never have existed
 * (DEVICE_INTEGRATION §6).
 */
function StatusBadge({ status, error }: { status: PrintJobStatus; error: string | null }) {
  switch (status) {
    case PrintJobStatus.CONFIRMED:
      return <Badge variant="ok">Printed</Badge>
    case PrintJobStatus.SENT:
      return <Badge variant="secondary">Sent</Badge>
    case PrintJobStatus.QUEUED:
      return <Badge variant="outline">Queued</Badge>
    case PrintJobStatus.FAILED:
      return (
        <span className="flex flex-col gap-1">
          <Badge variant="destructive">Failed</Badge>
          {error && <span className="text-xs text-muted-foreground">{error}</span>}
        </span>
      )
  }
}
