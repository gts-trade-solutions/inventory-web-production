import type { Metadata } from 'next'
import { Database, FlaskConical, ShieldCheck } from 'lucide-react'
import { requireUser } from '@/lib/auth/guards'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export const metadata: Metadata = { title: 'Dashboard' }

/**
 * Placeholder. The real dashboard — KPIs, low stock, the expiry board, recent
 * activity and device health — is Phase 3.12, once there is stock to report on.
 *
 * For now it proves the parts of Phase 0 that are hard to see: that the session
 * resolved, the role came through, and the mode picked a database.
 */
export default async function DashboardPage() {
  const user = await requireUser()

  const [items, movements, reasonCodes] = await Promise.all([
    user.db.item.count(),
    user.db.movement.count(),
    user.db.reasonCode.count(),
  ])

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome back, {user.name.split(' ')[0]}
        </h1>
        <p className="text-sm text-muted-foreground">
          Phase 0 is complete. Inventory screens arrive with Phase 3.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Stat label="Items" value={items} hint="Master data, Phase 3" />
        <Stat label="Ledger entries" value={movements} hint="Movements, Phase 1" />
        <Stat label="Reason codes" value={reasonCodes} hint="Seeded" />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Session</CardTitle>
          <CardDescription>What the server resolved for this request.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Row icon={<ShieldCheck className="size-4 text-muted-foreground" />} label="Signed in as">
            <span className="tabular">{user.email}</span>
            <Badge variant="secondary">{user.role}</Badge>
          </Row>

          <Row
            icon={
              user.mode === 'DEMO' ? (
                <FlaskConical className="size-4 text-demo" />
              ) : (
                <Database className="size-4 text-muted-foreground" />
              )
            }
            label="Mode"
          >
            <Badge variant={user.mode === 'DEMO' ? 'demo' : 'ok'}>{user.mode}</Badge>
            <span className="text-muted-foreground">
              reading{' '}
              <span className="tabular">
                {user.mode === 'DEMO' ? 'inventory_demo' : 'inventory'}
              </span>
            </span>
          </Row>
        </CardContent>
      </Card>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="tabular mt-1 text-3xl font-semibold">{value.toLocaleString()}</p>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  )
}

function Row({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {icon}
      <span className="text-muted-foreground">{label}:</span>
      {children}
    </div>
  )
}
