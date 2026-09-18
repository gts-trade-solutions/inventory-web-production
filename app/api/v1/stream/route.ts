import { NextResponse } from 'next/server'
import { bearerFrom, verifyAccessToken } from '@/lib/api/jwt'
import { ErrorCode } from '@/lib/api/errors'
import { events, isVisibleTo, type AppEvent } from '@/lib/events/bus'

/**
 * `GET /v1/stream` — live events over Server-Sent Events.
 *
 * SSE rather than WebSockets: this is one-way, it survives proxies that do not
 * understand upgrades, and the browser reconnects on its own with the last id
 * it saw. A warehouse network is not a laboratory, and a transport that heals
 * itself is worth more here than one that is bidirectional.
 *
 * Not written with `apiRoute` because that wrapper returns JSON. It repeats the
 * bearer check by hand, which is the one piece it genuinely needs.
 *
 * The connection is long-lived, so this route must run on Node rather than the
 * edge runtime, and must not be statically analysed away.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * A comment line every 25 seconds.
 *
 * Proxies and load balancers close idle connections, typically after 30–60
 * seconds, and an SSE stream on a quiet afternoon is idle by definition. The
 * heartbeat is what stops a console silently dying between tag reads.
 */
const HEARTBEAT_MS = 25_000

export async function GET(request: Request): Promise<Response> {
  /**
   * A browser's EventSource cannot set an Authorization header, so the web
   * console passes the token in the query string. That is a real trade-off —
   * query strings reach access logs and proxy logs in a way headers do not —
   * and it is accepted here because the alternative is worse: a cookie would
   * not work for the mobile client that shares this endpoint, and inventing a
   * second auth scheme for one route is how auth bugs are born.
   *
   * It is mitigated by the token being the short-lived ACCESS token (15
   * minutes), never the refresh token. A mobile client should still use the
   * header, which is checked first.
   */
  const token =
    bearerFrom(request.headers.get('authorization')) ??
    new URL(request.url).searchParams.get('token')

  if (!token) {
    return NextResponse.json(
      { error: { code: ErrorCode.TOKEN_INVALID, message: 'This endpoint needs a bearer token.' } },
      { status: 401 },
    )
  }

  const verified = await verifyAccessToken(token)
  if (!verified.ok) {
    return NextResponse.json(
      { error: { code: verified.code, message: 'That token is not usable.' } },
      { status: 401 },
    )
  }

  const { claims } = verified
  const url = new URL(request.url)

  const kinds = url.searchParams
    .get('kinds')
    ?.split(',')
    .map((kind) => kind.trim().toUpperCase())
  const lastEventId = Number.parseInt(
    request.headers.get('last-event-id') ?? url.searchParams.get('since') ?? '',
    10,
  )

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true
      const send = (chunk: string) => {
        if (!open) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          // The client vanished between our check and the write.
          open = false
        }
      }

      const deliver = (event: AppEvent) => {
        if (!isVisibleTo(event, { mode: claims.mode, siteIds: claims.siteIds })) return
        if (kinds && !kinds.includes(event.kind)) return

        send(`id: ${event.id}\nevent: ${event.kind}\ndata: ${JSON.stringify(event)}\n\n`)
      }

      // Tell the client how long to wait before reconnecting, then replay
      // anything it missed while it was away.
      send('retry: 3000\n\n')

      if (Number.isFinite(lastEventId)) {
        const { events: missed, gap } = events.since(lastEventId)
        if (gap) {
          // Said out loud. A client that assumes it has everything after a gap
          // shows a screen that is wrong rather than merely stale.
          send(
            `event: GAP\ndata: ${JSON.stringify({
              message: 'Some events were missed while disconnected. Reload to resynchronise.',
            })}\n\n`,
          )
        }
        for (const event of missed) deliver(event)
      }

      const unsubscribe = events.subscribe(deliver)
      const heartbeat = setInterval(() => send(': keep-alive\n\n'), HEARTBEAT_MS)

      const close = () => {
        if (!open) return
        open = false
        clearInterval(heartbeat)
        unsubscribe()
        try {
          controller.close()
        } catch {
          // Already closed by the runtime.
        }
      }

      // The only reliable signal that a browser tab went away.
      request.signal.addEventListener('abort', close)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // nginx buffers proxied responses by default, which holds every event
      // until the buffer fills — a live console that updates in bursts of
      // nothing and then everything.
      'X-Accel-Buffering': 'no',
      'X-App-Mode': claims.mode,
    },
  })
}
