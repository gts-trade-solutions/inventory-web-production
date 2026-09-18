import type { AppMode } from '@/lib/mode'

/**
 * The live event bus behind `/v1/stream`.
 *
 * A warehouse is a place where things happen to physical objects, and the
 * screens are more useful when they say so as it happens: a tag read appearing
 * on a count sheet, a print job landing, a reader dropping off the network. The
 * mobile MVP already has a device console; this is what lets the web have one
 * (DEVICE_INTEGRATION §7).
 *
 * IN-PROCESS ONLY. Events reach subscribers attached to the same Node process.
 * One server is the deployment we have, and that is what this is built for —
 * but it is a real limit, not an oversight: behind two instances a client
 * connected to A would never see events published on B. Moving to Redis or
 * Postgres LISTEN/NOTIFY means replacing this file and nothing else, which is
 * why publishers depend on the interface rather than on the implementation.
 *
 * Mode is carried on every event and enforced on delivery. A DEMO event
 * reaching a LIVE console would be demo data in a live screen, which is exactly
 * what WADR-024 exists to prevent.
 */

export const EventKind = {
  MOVEMENT: 'MOVEMENT',
  TAG_READ: 'TAG_READ',
  COUNT: 'COUNT',
  PRINT: 'PRINT',
  DEVICE: 'DEVICE',
} as const
export type EventKind = (typeof EventKind)[keyof typeof EventKind]

export interface AppEvent {
  /** Monotonic within a process; a client resumes from the last it saw. */
  id: number
  kind: EventKind
  at: string
  mode: AppMode
  siteId: string | null
  /** One line, written for a person watching a console. */
  summary: string
  /** Structured detail. Never contains anything a console should not show. */
  data: Record<string, unknown>
}

export type PublishInput = Omit<AppEvent, 'id' | 'at'>

type Listener = (event: AppEvent) => void

/**
 * How many events are kept for replay.
 *
 * A client that reconnects asks for everything after the last id it saw. The
 * buffer is small and bounded on purpose: this is a live console, not a log.
 * An unbounded buffer would grow for the lifetime of the process, and a client
 * away long enough to fall off the end is told to resync rather than silently
 * handed a gap.
 */
const BUFFER_SIZE = 200

class EventBus {
  private nextId = 1
  private readonly buffer: AppEvent[] = []
  private readonly listeners = new Set<Listener>()

  publish(input: PublishInput): AppEvent {
    const event: AppEvent = { ...input, id: this.nextId++, at: new Date().toISOString() }

    this.buffer.push(event)
    if (this.buffer.length > BUFFER_SIZE) this.buffer.shift()

    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // One broken subscriber must not stop the others, and must never fail
        // the operation that published. A dropped console line is nothing; a
        // failed stock movement is not.
      }
    }

    return event
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Events after `id`, for a client that reconnected.
   *
   * Returns `gap: true` when the requested id has already fallen out of the
   * buffer — the client then knows to resync rather than assume it has
   * everything, which is the difference between a stale screen and a wrong one.
   */
  since(id: number): { events: AppEvent[]; gap: boolean } {
    const oldest = this.buffer[0]
    if (!oldest) return { events: [], gap: false }

    return {
      events: this.buffer.filter((event) => event.id > id),
      gap: id > 0 && id < oldest.id - 1,
    }
  }

  /** Test seam. Never called by application code. */
  reset(): void {
    this.nextId = 1
    this.buffer.length = 0
    this.listeners.clear()
  }

  get subscriberCount(): number {
    return this.listeners.size
  }
}

/**
 * One bus per process — in every environment, not only in development.
 *
 * Stashed on globalThis for two reasons, and the second is the one that bit.
 *
 * In development, Next re-evaluates modules on every hot reload, and a fresh
 * bus each time would silently disconnect every open console.
 *
 * In PRODUCTION, Next's build puts route handlers and Server Actions in
 * separate bundles, and a module imported by both is instantiated once in each.
 * Guarding this assignment with `NODE_ENV !== 'production'` therefore gave the
 * SSE route its own bus and the self-test action another — the console
 * connected, stayed connected, and received nothing for ever. It worked
 * perfectly in dev, which is exactly why it survived until the first production
 * build.
 */
const globalForEvents = globalThis as unknown as { __eventBus?: EventBus }

export const events: EventBus = globalForEvents.__eventBus ?? new EventBus()

globalForEvents.__eventBus = events

/** Whether an event should reach a subscriber. Mode is not negotiable. */
export function isVisibleTo(
  event: AppEvent,
  subscriber: { mode: AppMode; siteIds: readonly string[] },
): boolean {
  if (event.mode !== subscriber.mode) return false

  // A site-less event is system-wide; otherwise the subscriber must hold it.
  return event.siteId === null || subscriber.siteIds.includes(event.siteId)
}
