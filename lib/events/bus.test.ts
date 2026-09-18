import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventKind, events, isVisibleTo, type AppEvent } from './bus'

/**
 * The live event bus.
 *
 * Two properties matter more than the rest: a DEMO event must never reach a
 * LIVE console, and a subscriber that throws must not take down the operation
 * that published.
 */

const base = {
  kind: EventKind.MOVEMENT,
  mode: 'DEMO' as const,
  siteId: 'site-1',
  summary: 'Received 12 boxes into A-01',
  data: {},
}

beforeEach(() => {
  events.reset()
})

describe('publishing', () => {
  it('delivers to every subscriber', () => {
    const seen: AppEvent[] = []
    events.subscribe((event) => seen.push(event))
    events.subscribe((event) => seen.push(event))

    events.publish(base)

    expect(seen).toHaveLength(2)
    expect(seen[0]?.summary).toBe('Received 12 boxes into A-01')
  })

  it('stamps an increasing id and a timestamp', () => {
    const first = events.publish(base)
    const second = events.publish(base)

    expect(second.id).toBeGreaterThan(first.id)
    expect(Number.isNaN(Date.parse(first.at))).toBe(false)
  })

  it('does not let one broken subscriber break the others', () => {
    // A dropped console line is nothing. A stock movement that failed because a
    // console was open is not.
    const seen: AppEvent[] = []
    events.subscribe(() => {
      throw new Error('this listener is broken')
    })
    events.subscribe((event) => seen.push(event))

    expect(() => events.publish(base)).not.toThrow()
    expect(seen).toHaveLength(1)
  })

  it('stops delivering after unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = events.subscribe(listener)

    events.publish(base)
    unsubscribe()
    events.publish(base)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(events.subscriberCount).toBe(0)
  })
})

describe('replay', () => {
  it('returns what a reconnecting client missed', () => {
    const first = events.publish(base)
    events.publish({ ...base, summary: 'second' })
    events.publish({ ...base, summary: 'third' })

    const { events: missed, gap } = events.since(first.id)

    expect(missed.map((event) => event.summary)).toEqual(['second', 'third'])
    expect(gap).toBe(false)
  })

  it('is empty when the client is up to date', () => {
    const last = events.publish(base)
    expect(events.since(last.id).events).toEqual([])
  })

  it('keeps the buffer bounded', () => {
    // This is a live console, not a log. An unbounded buffer would grow for the
    // lifetime of the process.
    for (let i = 0; i < 500; i++) events.publish({ ...base, summary: `event ${i}` })

    const all = events.since(0)
    expect(all.events.length).toBeLessThanOrEqual(200)
    expect(all.events[all.events.length - 1]?.summary).toBe('event 499')
  })

  it('reports a gap when the client fell too far behind', () => {
    // Being told to resync is the difference between a stale screen and a wrong
    // one.
    for (let i = 0; i < 500; i++) events.publish({ ...base, summary: `event ${i}` })

    expect(events.since(1).gap).toBe(true)
  })

  it('does not report a gap for a fresh client', () => {
    events.publish(base)
    expect(events.since(0).gap).toBe(false)
  })
})

describe('who sees what', () => {
  const demoEvent = { ...base, id: 1, at: '2026-09-18T10:00:00.000Z' }

  it('never shows a DEMO event to a LIVE console', () => {
    // Demo data reaching a live screen is precisely what WADR-024 prevents.
    expect(isVisibleTo(demoEvent, { mode: 'LIVE', siteIds: ['site-1'] })).toBe(false)
    expect(isVisibleTo(demoEvent, { mode: 'DEMO', siteIds: ['site-1'] })).toBe(true)
  })

  it('only shows a site event to someone who holds that site', () => {
    expect(isVisibleTo(demoEvent, { mode: 'DEMO', siteIds: ['site-2'] })).toBe(false)
    expect(isVisibleTo(demoEvent, { mode: 'DEMO', siteIds: [] })).toBe(false)
  })

  it('shows a system-wide event to everyone in the right mode', () => {
    const systemEvent = { ...demoEvent, siteId: null }

    expect(isVisibleTo(systemEvent, { mode: 'DEMO', siteIds: [] })).toBe(true)
    expect(isVisibleTo(systemEvent, { mode: 'LIVE', siteIds: [] })).toBe(false)
  })
})
