import type { Metadata } from 'next'
import { DeviceKind } from '@prisma/client'
import { Cpu, Printer, Radio, ScanLine, Smartphone } from 'lucide-react'
import { requireUser } from '@/lib/auth/guards'
import { STALE_AFTER_MINUTES, listDevices, type DeviceRow } from '@/lib/services/devices'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { signAccessToken } from '@/lib/api/jwt'
import { SelfTestButton } from './self-test-button'
import { EventConsole } from './event-console'

export const metadata: Metadata = { title: 'Devices' }

/**
 * The hardware register.
 *
 * Every device carries a self-test that reports what happened at each step. On
 * hardware day this screen IS the bring-up record; before then it is how the
 * whole device story can be shown working without owning any of it
 * (DEVICE_INTEGRATION §7, §11.3).
 */
export default async function DevicesPage() {
  const user = await requireUser()
  const devices = await listDevices(user.db, { includeRetired: true })

  // A short-lived token for the console's SSE connection. The browser's
  // EventSource cannot set an Authorization header, and the same endpoint
  // serves the mobile client, so one auth scheme is better than two.
  const streamToken = await signAccessToken({
    userId: user.userId,
    role: user.role,
    siteIds: user.siteIds,
    deviceId: null,
    mode: user.mode,
  })

  const groups: Array<{ kind: DeviceKind; title: string; blurb: string }> = [
    {
      kind: DeviceKind.PRINTER,
      title: 'Printers',
      blurb: 'Label printers on the network, or attached to a workstation.',
    },
    {
      kind: DeviceKind.RFID_READER,
      title: 'RFID readers',
      blurb: 'Fixed readers that sweep an aisle and stream tag reads.',
    },
    {
      kind: DeviceKind.SCANNER,
      title: 'Scanners',
      blurb: 'Barcode and ring scanners. These connect to the browser, not the server.',
    },
    {
      kind: DeviceKind.MOBILE_COMPUTER,
      title: 'Handsets',
      blurb: 'Devices running the mobile app. They register themselves on sign-in.',
    },
  ]

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Devices"
        description="Every scanner, reader and printer the system knows about — and whether it is working."
      />

      <div className="mb-6">
        <EventConsole token={streamToken} />
      </div>

      {devices.length === 0 ? (
        <EmptyState
          title="No devices yet"
          hint="Printers and fixed readers are added by an administrator. Scanners and handsets register themselves the first time they connect."
        />
      ) : (
        <div className="space-y-6">
          {groups.map((group) => {
            const inGroup = devices.filter((device) => device.kind === group.kind)
            if (inGroup.length === 0) return null

            return (
              <Card key={group.kind}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <IconFor kind={group.kind} />
                    {group.title}
                  </CardTitle>
                  <p className="text-sm text-muted-foreground">{group.blurb}</p>
                </CardHeader>
                <CardContent className="space-y-3">
                  {inGroup.map((device) => (
                    <DeviceCard key={device.id} device={device} />
                  ))}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

function DeviceCard({ device }: { device: DeviceRow }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{device.label}</span>

            {/*
              Never hidden. A simulated device is safe to leave enabled in
              staging precisely because nobody can mistake it for real one
              (DEVICE_INTEGRATION §8).
            */}
            {device.simulated && <Badge variant="demo">Simulation</Badge>}
            {!device.active && <Badge variant="secondary">Retired</Badge>}
            <Presence device={device} />
          </div>

          <p className="mt-1 text-sm text-muted-foreground">
            {[device.vendor, device.model].filter(Boolean).join(' ') || 'Unspecified model'}
            {device.address && <span className="tabular"> · {device.address}</span>}
            {device.siteCode && <span> · {device.siteCode}</span>}
          </p>

          {device.assignedTo && (
            <p className="text-sm text-muted-foreground">Assigned to {device.assignedTo}</p>
          )}
        </div>

        <SelfTestButton deviceId={device.id} label={device.label} disabled={!device.active} />
      </div>
    </div>
  )
}

/**
 * How long since we heard from it.
 *
 * "Never" is not a fault for a printer — a networked printer says nothing until
 * something is sent to it. It is worth noticing on a handset.
 */
function Presence({ device }: { device: DeviceRow }) {
  if (device.quietForMinutes === null) {
    return <Badge variant="outline">Not heard from yet</Badge>
  }

  if (device.quietForMinutes > STALE_AFTER_MINUTES) {
    const days = Math.floor(device.quietForMinutes / 60 / 24)
    return (
      <Badge variant="warn">
        Quiet for {days > 0 ? `${days} day${days === 1 ? '' : 's'}` : 'a while'}
      </Badge>
    )
  }

  return <Badge variant="ok">Seen recently</Badge>
}

function IconFor({ kind }: { kind: DeviceKind }) {
  const className = 'size-4 text-muted-foreground'

  switch (kind) {
    case DeviceKind.PRINTER:
      return <Printer className={className} />
    case DeviceKind.RFID_READER:
      return <Radio className={className} />
    case DeviceKind.SCANNER:
      return <ScanLine className={className} />
    case DeviceKind.MOBILE_COMPUTER:
      return <Smartphone className={className} />
    default:
      return <Cpu className={className} />
  }
}
