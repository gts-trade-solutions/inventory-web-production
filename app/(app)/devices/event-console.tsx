'use client'

import { useEffect, useRef, useState } from 'react'
import { Activity, AlertTriangle, Pause, Play } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/**
 * The live event console.
 *
 * The mobile MVP has one, and it earns its place the same way here: during a
 * rollout it is the fastest way to tell a working setup from a broken one. A
 * scan that produces no line means the scanner is not reaching the app, which
 * looks identical from the operator's side to a scan that was simply wrong.
 *
 * It listens over SSE, which reconnects itself. A console that quietly dies
 * after a proxy timeout is worse than no console — it says "nothing is
 * happening" when the truth is "I stopped listening".
 */

interface StreamEvent {
  id: number
  kind: string
  at: string
  summary: string
}

/** Mirrors EventKind. A client component may not import Prisma or server values. */
const EVENT_KINDS = ['MOVEMENT', 'TAG_READ', 'COUNT', 'PRINT', 'DEVICE'] as const

const MAX_LINES = 60

export function EventConsole({ token }: { token: string }) {
  const [lines, setLines] = useState<StreamEvent[]>([])
  const [connected, setConnected] = useState(false)
  const [paused, setPaused] = useState(false)
  const [gap, setGap] = useState(false)
  const pausedRef = useRef(paused)

  pausedRef.current = paused

  useEffect(() => {
    // EventSource cannot send an Authorization header, so the token goes in the
    // query string. It is a short-lived access token scoped to this user, and
    // the alternative — a cookie — would not work for the mobile client that
    // shares this endpoint.
    const source = new EventSource(`/api/v1/stream?token=${encodeURIComponent(token)}`)

    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)

    source.addEventListener('GAP', () => setGap(true))

    const receive = (message: MessageEvent<string>) => {
      if (pausedRef.current) return
      try {
        const event = JSON.parse(message.data) as StreamEvent
        setLines((current) => [event, ...current].slice(0, MAX_LINES))
      } catch {
        // A line we cannot parse is not worth breaking the console over.
      }
    }

    // The server names each event by kind, so clients can subscribe to just the
    // ones they want. That means `onmessage` never fires — it only receives
    // events with no `event:` field — and a console wired to it renders
    // perfectly while showing nothing for ever.
    for (const kind of EVENT_KINDS) source.addEventListener(kind, receive)

    return () => {
      for (const kind of EVENT_KINDS) source.removeEventListener(kind, receive)
      source.close()
    }
  }, [token])

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <Activity className={cn('size-4', connected && 'text-ok')} />
            Live activity
          </CardTitle>

          <div className="flex items-center gap-2">
            <Badge variant={connected ? 'ok' : 'secondary'}>
              {connected ? 'Connected' : 'Reconnecting…'}
            </Badge>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPaused((value) => !value)}
            >
              {paused ? <Play className="mr-2 size-4" /> : <Pause className="mr-2 size-4" />}
              {paused ? 'Resume' : 'Pause'}
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          Movements, tag reads, print jobs and device events, as they happen.
        </p>
      </CardHeader>

      <CardContent>
        {gap && (
          <p className="mb-3 flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            {/* Said out loud: a console that hides a gap shows a screen that is
                wrong rather than merely incomplete. */}
            Some events were missed while disconnected. Reload to see everything.
          </p>
        )}

        {lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing yet. Record a movement, sweep a bay or print a label and it will appear here.
          </p>
        ) : (
          <ul className="space-y-1">
            {lines.map((event) => (
              <li key={event.id} className="flex gap-3 text-sm">
                <span className="tabular w-16 shrink-0 text-xs text-muted-foreground">
                  {new Date(event.at).toLocaleTimeString()}
                </span>
                <Badge variant="outline" className="h-5 shrink-0 text-[10px]">
                  {event.kind.replace('_', ' ')}
                </Badge>
                <span className="min-w-0">{event.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
