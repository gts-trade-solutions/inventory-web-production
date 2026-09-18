import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth/guards'
import { PageHeader } from '@/components/page-header'
import { SimulatedHandset } from './outbox'

export const metadata: Metadata = { title: 'Simulated handset' }

/**
 * The offline-and-sync demonstration.
 *
 * Shows the MOBILE contract from the web, before the mobile app exists: queue
 * work while disconnected, push it as one batch, and get a verdict per row
 * (DEMO_MODE §6).
 *
 * Demo mode only. Not because the code would misbehave in Live — the action
 * refuses there anyway — but because a "switch the network off" button on a
 * live warehouse screen is an invitation to a very confusing afternoon.
 */
export default async function SimulatedHandsetPage() {
  const user = await requireUser()
  if (user.mode !== 'DEMO') notFound()

  const [items, locations] = await Promise.all([
    user.db.item.findMany({
      where: { active: true, deletedAt: null, trackingMode: 'NONE' },
      select: { id: true, sku: true, name: true },
      orderBy: { sku: 'asc' },
      take: 50,
    }),
    user.db.location.findMany({
      where: { active: true, deletedAt: null },
      select: { id: true, code: true, name: true },
      orderBy: { code: 'asc' },
    }),
  ])

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title="Simulated handset"
        description="Record work with the network off, then reconnect and watch the shared backend judge every row."
      />

      <SimulatedHandset
        items={items.map((item) => ({ id: item.id, label: `${item.sku} — ${item.name}` }))}
        locations={locations.map((location) => ({
          id: location.id,
          label: `${location.code} — ${location.name}`,
        }))}
      />

      <p className="text-sm text-muted-foreground">
        {/* Only untracked items are offered: a batch or serial item needs a batch
            number or unit ids that a two-field form cannot honestly supply. */}
        Untracked items only — a batch or serial movement needs more than this form collects.
        Flagged rows appear in <Link href="/exceptions" className="underline">Exceptions</Link>, and
        everything recorded here lands in the same ledger as the rest of the system.
      </p>
    </div>
  )
}
