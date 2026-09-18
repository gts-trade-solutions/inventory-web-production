import type { Metadata } from 'next'
import Link from 'next/link'
import { BarChart3, Clock, ClipboardCheck, PackageSearch, ShoppingCart } from 'lucide-react'
import { requireUser } from '@/lib/auth/guards'
import { PageHeader } from '@/components/page-header'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export const metadata: Metadata = { title: 'Reports' }

const REPORTS = [
  {
    href: '/reports/stock',
    title: 'Stock on hand',
    icon: PackageSearch,
    description:
      'What is on hand, grouped by item, by location, or down to the batch. Negative lines are shown, not hidden — they are the ones worth acting on.',
  },
  {
    href: '/reports/movements',
    title: 'Movement summary',
    icon: BarChart3,
    description:
      'What moved over a period, by type, straight from the ledger. Types with nothing in the period are listed as zero rather than left out.',
  },
  {
    href: '/reports/counts',
    title: 'Count accuracy',
    icon: ClipboardCheck,
    description:
      'How well counts matched the system. Scored by lines rather than units, so one bulk item cannot hide a dozen real discrepancies.',
  },
  {
    href: '/reports/ageing',
    title: 'Stock ageing',
    icon: Clock,
    description:
      'How long stock has been sitting. Only batch-tracked stock has a knowable age; the rest is reported as unknown rather than guessed at.',
  },
  {
    href: '/reports/reorder',
    title: 'Reorder',
    icon: ShoppingCart,
    description:
      'Items at or below their reorder point, most short first, with a suggested quantity where a maximum level is set.',
  },
] as const

export default async function ReportsPage() {
  await requireUser()

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Reports"
        description="Stock figures come from the projection, which the nightly sweep checks against the ledger. Movement figures come from the ledger itself. Every report says which it used."
      />

      <div className="grid gap-4 sm:grid-cols-2">
        {REPORTS.map((report) => (
          <Link key={report.href} href={report.href} className="group">
            <Card className="h-full transition-colors group-hover:border-primary">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <report.icon className="size-4 text-muted-foreground" />
                  {report.title}
                </CardTitle>
                <CardDescription>{report.description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
