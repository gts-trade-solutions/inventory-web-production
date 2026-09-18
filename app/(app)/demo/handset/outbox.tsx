'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  CloudOff,
  Cloud,
  Loader2,
  Plus,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { syncOutboxAction, type SyncOutcome } from './actions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

interface Option {
  id: string
  label: string
}

interface Row {
  id: string
  itemId: string
  itemLabel: string
  type: 'RECEIVE' | 'ISSUE'
  quantity: number
  fromLocationId: string | null
  toLocationId: string | null
  locationLabel: string
  occurredAt: string
}

const STORAGE_KEY = 'demo-handset-outbox'

/**
 * A handset that works while disconnected and syncs when it reconnects.
 *
 * The queue lives in the browser, because that is where a phone's outbox lives.
 * The push goes to the real service, so every verdict is genuine — a real
 * document number, a real duplicate on replay, a real negative-stock flag that
 * turns up in Exceptions afterwards.
 */
export function SimulatedHandset({ items, locations }: { items: Option[]; locations: Option[] }) {
  const [online, setOnline] = useState(false)
  const [rows, setRows] = useState<Row[]>([])
  const [outcome, setOutcome] = useState<SyncOutcome>({})
  const [syncing, setSyncing] = useState(false)

  const [itemId, setItemId] = useState(items[0]?.id ?? '')
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '')
  const [type, setType] = useState<'RECEIVE' | 'ISSUE'>('RECEIVE')
  const [quantity, setQuantity] = useState(12)

  // Restored on load, because a phone that forgets its outbox when the screen
  // sleeps has lost somebody's work — which is the failure this whole design
  // exists to prevent.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY)
      if (stored) setRows(JSON.parse(stored) as Row[])
    } catch {
      // Private browsing, or cleared storage. An empty outbox is correct here.
    }
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(rows))
    } catch {
      // Nothing to do; the queue still works for this session.
    }
  }, [rows])

  const queue = useCallback(() => {
    const item = items.find((candidate) => candidate.id === itemId)
    const location = locations.find((candidate) => candidate.id === locationId)
    if (!item || !location) return

    setRows((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        itemId,
        itemLabel: item.label,
        type,
        quantity,
        fromLocationId: type === 'ISSUE' ? locationId : null,
        toLocationId: type === 'RECEIVE' ? locationId : null,
        locationLabel: location.label,
        // The operator's clock, recorded and not trusted. The server stamps its
        // own time on arrival (API_CONTRACT §9.2).
        occurredAt: new Date().toISOString(),
      },
    ])
    setOutcome({})
  }, [itemId, items, locationId, locations, quantity, type])

  const sync = useCallback(async () => {
    setSyncing(true)
    try {
      const result = await syncOutboxAction(
        rows.map(({ id, itemId, type, quantity, fromLocationId, toLocationId, occurredAt }) => ({
          id,
          itemId,
          type,
          quantity,
          fromLocationId,
          toLocationId,
          occurredAt,
        })),
      )

      setOutcome(result)

      // Rows are cleared only once a verdict has come back for them. Clearing
      // on send would lose work the moment a push failed halfway.
      if (result.results) {
        const judged = new Set(result.results.map((verdict) => verdict.id))
        setRows((current) => current.filter((row) => !judged.has(row.id)))
      }
    } finally {
      setSyncing(false)
    }
  }, [rows])

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2">
              {online ? (
                <Cloud className="size-4 text-ok" />
              ) : (
                <CloudOff className="size-4 text-warn" />
              )}
              Simulated handset
            </CardTitle>

            <div className="flex items-center gap-2">
              {rows.length > 0 && <Badge variant="warn">{rows.length} pending</Badge>}
              <Button
                type="button"
                variant={online ? 'outline' : 'default'}
                size="sm"
                onClick={() => setOnline((value) => !value)}
              >
                {online ? 'Switch the network off' : 'Switch the network on'}
              </Button>
            </div>
          </div>

          <p className="text-sm text-muted-foreground">
            Work recorded while disconnected is queued here, exactly as the phone will queue it.
            Reconnecting pushes the whole outbox through the shared API and judges each row on its
            own.
          </p>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="itemId">Item</Label>
              <select
                id="itemId"
                value={itemId}
                onChange={(event) => setItemId(event.target.value)}
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="type">Movement</Label>
              <select
                id="type"
                value={type}
                onChange={(event) => setType(event.target.value as 'RECEIVE' | 'ISSUE')}
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="RECEIVE">Receive</option>
                <option value="ISSUE">Issue</option>
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="quantity">Quantity</Label>
              <Input
                id="quantity"
                type="number"
                min={1}
                value={quantity}
                onChange={(event) => setQuantity(Math.max(1, Number(event.target.value) || 1))}
              />
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="locationId">Location</Label>
              <select
                id="locationId"
                value={locationId}
                onChange={(event) => setLocationId(event.target.value)}
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={queue}>
              <Plus className="mr-2 size-4" />
              Record
            </Button>

            <Button
              type="button"
              variant="outline"
              onClick={() => void sync()}
              disabled={!online || rows.length === 0 || syncing}
            >
              {syncing ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Syncing…
                </>
              ) : (
                `Sync ${rows.length} movement${rows.length === 1 ? '' : 's'}`
              )}
            </Button>

            {!online && (
              <span className="text-sm text-muted-foreground">
                Offline — nothing reaches the server until you switch the network on.
              </span>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            To see a flagged row, issue more than is on hand. Work done on the floor is accepted
            even when it drives stock negative, and lands in Exceptions for a supervisor rather than
            being thrown away.
          </p>
        </CardContent>
      </Card>

      {rows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Waiting to sync</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {rows.map((row) => (
              <div
                key={row.id}
                className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm"
              >
                <Badge variant="secondary">{row.type === 'RECEIVE' ? 'Receive' : 'Issue'}</Badge>
                <span className="flex-1">
                  {row.quantity} × {row.itemLabel}{' '}
                  <span className="text-muted-foreground">
                    {row.type === 'RECEIVE' ? 'into' : 'from'} {row.locationLabel}
                  </span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setRows((current) => current.filter((it) => it.id !== row.id))}
                >
                  <Trash2 className="size-4" />
                  <span className="sr-only">Discard</span>
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {outcome.error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{outcome.error}</AlertDescription>
        </Alert>
      )}

      {outcome.results && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">What the server said</CardTitle>
            <p className="text-sm text-muted-foreground">
              One verdict per row. A bad row never blocks the batch — a phone that cannot sync
              because of a single entry is a phone that stops being used.
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            {outcome.results.map((verdict) => (
              <Verdict key={verdict.id} verdict={verdict} />
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function Verdict({ verdict }: { verdict: NonNullable<SyncOutcome['results']>[number] }) {
  const tone =
    verdict.status === 'ACCEPTED'
      ? 'ok'
      : verdict.status === 'DUPLICATE'
        ? 'secondary'
        : verdict.status === 'FLAGGED'
          ? 'warn'
          : 'destructive'

  return (
    <div className={cn('flex flex-wrap items-center gap-3 rounded-md border px-3 py-2 text-sm')}>
      {verdict.status === 'ACCEPTED' ? (
        <CheckCircle2 className="size-4 text-ok" />
      ) : verdict.status === 'FLAGGED' ? (
        <TriangleAlert className="size-4 text-warn" />
      ) : (
        <AlertCircle className="size-4 text-muted-foreground" />
      )}

      <Badge variant={tone}>{verdict.status.toLowerCase()}</Badge>

      {'docNo' in verdict && <span className="tabular">{verdict.docNo}</span>}

      <span className="min-w-0 flex-1 text-muted-foreground">
        {verdict.status === 'FLAGGED'
          ? 'Recorded, but it drove stock negative. A supervisor owns it now — see Exceptions.'
          : verdict.status === 'DUPLICATE'
            ? 'Already recorded. Resending is safe and changed nothing.'
            : verdict.status === 'REJECTED'
              ? verdict.error.message
              : 'Recorded.'}
      </span>
    </div>
  )
}
