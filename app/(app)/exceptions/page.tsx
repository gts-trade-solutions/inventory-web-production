import type { Metadata } from 'next'
import Link from 'next/link'
import { UserRole } from '@prisma/client'
import {
  AlertTriangle,
  CalendarX,
  CheckCircle2,
  ClipboardCheck,
  ShieldAlert,
  Scale,
} from 'lucide-react'
import { requireRole } from '@/lib/auth/guards'
import { loadExceptions } from '@/lib/services/exceptions'
import { PageHeader } from '@/components/page-header'
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

export const metadata: Metadata = { title: 'Exceptions' }

/**
 * One page a supervisor can open to see whether the warehouse is telling the
 * truth today.
 *
 * Supervisor and above: every item here is something only they can resolve.
 */
export default async function ExceptionsPage() {
  const user = await requireRole(UserRole.SUPERVISOR)
  const exceptions = await loadExceptions(user.db)

  if (exceptions.clean) {
    return (
      <div className="mx-auto max-w-4xl">
        <PageHeader
          title="Exceptions"
          description="Everything that needs a person to look at it."
        />
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <CheckCircle2 className="size-8 text-ok" />
            <p className="text-lg font-medium">Nothing needs attention</p>
            <p className="max-w-md text-sm text-muted-foreground">
              No negative stock, no expired stock on the shelf, no counts waiting for approval, and
              every stock figure matches the ledger behind it.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title="Exceptions" description="Everything that needs a person to look at it." />

      {exceptions.projectionDrift.count > 0 && (
        <Section
          title="Stock figures that disagree with the ledger"
          description="A stock number the movements behind it do not explain. This should never happen; it means a row was changed outside the application. An admin can rebuild the projection."
          icon={<Scale className="size-4" />}
          tone="destructive"
          count={exceptions.projectionDrift.count}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Stored</TableHead>
                <TableHead className="text-right">From the ledger</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {exceptions.projectionDrift.rows.map((row) => (
                <TableRow key={`${row.itemId}-${row.locationId}-${row.batchId}`}>
                  <TableCell className="tabular text-xs">{row.itemId.slice(0, 8)}…</TableCell>
                  <TableCell className="tabular text-right">{row.projected}</TableCell>
                  <TableCell className="tabular text-right font-medium">{row.fromLedger}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}

      {exceptions.negativeStock.count > 0 && (
        <Section
          title="Negative stock"
          description="More was issued than the system thought was there — usually two devices issuing the same units while offline. The movements are real; the shelf needs counting."
          icon={<AlertTriangle className="size-4" />}
          tone="destructive"
          count={exceptions.negativeStock.count}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Batch</TableHead>
                <TableHead className="text-right">On hand</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {exceptions.negativeStock.rows.map((row) => (
                <TableRow key={`${row.itemId}-${row.locationCode}-${row.batchNo ?? ''}`}>
                  <TableCell>
                    <Link href={`/inventory/${row.itemId}`} className="font-medium hover:underline">
                      {row.itemName}
                    </Link>
                    <span className="tabular block text-xs text-muted-foreground">
                      {row.itemSku}
                    </span>
                  </TableCell>
                  <TableCell className="tabular">{row.locationCode}</TableCell>
                  <TableCell className="tabular text-sm">{row.batchNo ?? '—'}</TableCell>
                  <TableCell className="tabular text-right font-medium text-destructive">
                    {row.quantity}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}

      {exceptions.countsAwaitingApproval.count > 0 && (
        <Section
          title="Counts waiting for approval"
          description="Counted and submitted. Nothing has reached the ledger until somebody approves them."
          icon={<ClipboardCheck className="size-4" />}
          tone="warn"
          count={exceptions.countsAwaitingApproval.count}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead>Location</TableHead>
                <TableHead className="text-right">Lines out</TableHead>
                <TableHead className="text-right">Net units</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {exceptions.countsAwaitingApproval.rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="tabular text-xs">
                    <Link href={`/counts/${row.id}`} className="font-medium hover:underline">
                      {row.docNo}
                    </Link>
                  </TableCell>
                  <TableCell className="tabular">{row.locationCode}</TableCell>
                  <TableCell className="tabular text-right">{row.lines}</TableCell>
                  <TableCell className="tabular text-right font-medium">
                    {row.netUnits > 0 ? `+${row.netUnits}` : row.netUnits}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}

      {exceptions.expiredOnHand.count > 0 && (
        <Section
          title="Expired stock still on the shelf"
          description="Past its expiry date and still counted. It cannot be issued, so it occupies space until it is scrapped or released."
          icon={<CalendarX className="size-4" />}
          tone="warn"
          count={exceptions.expiredOnHand.count}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Batch</TableHead>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Expired</TableHead>
                <TableHead className="text-right">On hand</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {exceptions.expiredOnHand.rows.map((row) => (
                <TableRow key={row.batchId}>
                  <TableCell className="tabular">
                    <Link href={`/batches/${row.batchId}`} className="font-medium hover:underline">
                      {row.batchNo}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/inventory/${row.itemId}`} className="hover:underline">
                      {row.itemName}
                    </Link>
                  </TableCell>
                  <TableCell className="tabular text-right text-warn">{row.daysAgo}d ago</TableCell>
                  <TableCell className="tabular text-right font-medium">
                    {row.onHand} {row.unit}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}

      {exceptions.quarantined.count > 0 && (
        <Section
          title="Quarantined or blocked batches"
          description="Frozen pending a decision. The stock is still on the shelf and still counted, but cannot be issued."
          icon={<ShieldAlert className="size-4" />}
          tone="muted"
          count={exceptions.quarantined.count}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Batch</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">On hand</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {exceptions.quarantined.rows.map((row) => (
                <TableRow key={row.batchId}>
                  <TableCell className="tabular">
                    <Link href={`/batches/${row.batchId}`} className="font-medium hover:underline">
                      {row.batchNo}
                    </Link>
                  </TableCell>
                  <TableCell>{row.itemName}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{row.status}</Badge>
                  </TableCell>
                  <TableCell className="tabular text-right">{row.onHand}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}
    </div>
  )
}

function Section({
  title,
  description,
  icon,
  tone,
  count,
  children,
}: {
  title: string
  description: string
  icon: React.ReactNode
  tone: 'destructive' | 'warn' | 'muted'
  count: number
  children: React.ReactNode
}) {
  return (
    <Card
      className={
        tone === 'destructive'
          ? 'border-destructive/40'
          : tone === 'warn'
            ? 'border-warn/50'
            : undefined
      }
    >
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <span
            className={
              tone === 'destructive'
                ? 'text-destructive'
                : tone === 'warn'
                  ? 'text-warn'
                  : 'text-muted-foreground'
            }
          >
            {icon}
          </span>
          {title}
          <Badge
            variant={tone === 'muted' ? 'secondary' : tone === 'warn' ? 'warn' : 'destructive'}
          >
            {count}
          </Badge>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="p-0">{children}</CardContent>
    </Card>
  )
}
