import { describe, expect, it } from 'vitest'
import { SimulatedRfidReader } from './rfid-reader'

/**
 * The simulated reader is the only way anybody sees an RFID cycle count work
 * before hardware arrives, so what it teaches people matters as much as what it
 * returns.
 */

const epcs = (count: number, from = 1) =>
  Array.from({ length: count }, (_, i) => `30361F49C8000040${String(from + i).padStart(8, '0')}`)

describe('sweeping', () => {
  it('returns tags that are in range', () => {
    const reader = new SimulatedRfidReader({ readRate: 1, readsPerTag: 1 })
    reader.load({ epcs: epcs(10) })

    const seen = new Set(reader.sweep().map((read) => read.epc))

    expect(seen.size).toBe(10)
  })

  it('misses some of them', () => {
    // A reader that returns everything every time teaches an operator that a
    // clean count is normal — so when a real one comes back two short they
    // conclude the system is broken.
    const reader = new SimulatedRfidReader({ readRate: 0.92, seed: 7 })
    reader.load({ epcs: epcs(100) })

    const seen = new Set(reader.sweep().map((read) => read.epc))

    expect(seen.size).toBeLessThan(100)
    expect(seen.size).toBeGreaterThan(80)
  })

  it('sees the same tag several times in one sweep', () => {
    // Which is why tag reads are de-duplicated by (session, EPC): counting
    // every read would multiply stock by the dwell time.
    const reader = new SimulatedRfidReader({ readRate: 1, readsPerTag: 4, seed: 3 })
    reader.load({ epcs: epcs(20) })

    const reads = reader.sweep()

    expect(reads.length).toBeGreaterThan(20)
    expect(new Set(reads.map((r) => r.epc)).size).toBe(20)
  })

  it('picks up strays from the next aisle, weakly', () => {
    const reader = new SimulatedRfidReader({ readRate: 1, readsPerTag: 1, seed: 11 })
    reader.load({ epcs: epcs(5), strays: epcs(40, 500) })

    const reads = reader.sweep()
    const strays = reads.filter((read) => !epcs(5).includes(read.epc))

    expect(strays.length).toBeGreaterThan(0)
    // Weak reads are how an operator tells a stray from stock on the shelf.
    const weakest = Math.max(...reads.filter((r) => epcs(5).includes(r.epc)).map((r) => r.rssi!))
    expect(Math.max(...strays.map((s) => s.rssi!))).toBeLessThan(weakest)
  })

  it('reports plausible antennas and signal strengths', () => {
    const reader = new SimulatedRfidReader({ readRate: 1, seed: 5 })
    reader.load({ epcs: epcs(30) })

    for (const read of reader.sweep()) {
      expect(read.antenna).toBeGreaterThanOrEqual(1)
      expect(read.antenna).toBeLessThanOrEqual(4)
      // Negative dBm. A positive RSSI is the signature of reading the field
      // unsigned, and it must not appear even in simulation.
      expect(read.rssi).toBeLessThan(0)
      expect(read.rssi).toBeGreaterThan(-100)
    }
  })

  it('emits EPCs in the shape the rest of the system stores', () => {
    const reader = new SimulatedRfidReader({ readRate: 1 })
    reader.load({ epcs: epcs(3).map((e) => e.toLowerCase()) })

    for (const read of reader.sweep()) {
      expect(read.epc).toMatch(/^[0-9A-F]{24}$/)
    }
  })

  it('returns nothing when the bin is empty', () => {
    const reader = new SimulatedRfidReader()
    reader.load({ epcs: [] })

    expect(reader.sweep()).toEqual([])
  })
})

describe('repeatability', () => {
  it('gives the same result for the same seed', () => {
    // A demo that produces a different variance every run cannot be rehearsed,
    // and somebody presenting to a room needs to know what the screen will say.
    const first = new SimulatedRfidReader({ seed: 42 })
    const second = new SimulatedRfidReader({ seed: 42 })
    first.load({ epcs: epcs(50) })
    second.load({ epcs: epcs(50) })

    const at = new Date('2026-09-17T10:00:00.000Z')
    expect(first.sweep(at)).toEqual(second.sweep(at))
  })

  it('gives different results for different seeds', () => {
    const first = new SimulatedRfidReader({ seed: 1 })
    const second = new SimulatedRfidReader({ seed: 2 })
    first.load({ epcs: epcs(50) })
    second.load({ epcs: epcs(50) })

    const at = new Date('2026-09-17T10:00:00.000Z')
    expect(first.sweep(at)).not.toEqual(second.sweep(at))
  })
})

describe('continuous inventory', () => {
  it('streams reads until stopped', async () => {
    const reader = new SimulatedRfidReader({ readRate: 1, seed: 9 })
    reader.load({ epcs: epcs(5) })

    const reads = await reader.inventoryFor(150, 30)

    expect(reads.length).toBeGreaterThan(5)
  })

  it('stops when the window closes', async () => {
    const reader = new SimulatedRfidReader({ readRate: 1 })
    reader.load({ epcs: epcs(5) })

    await reader.inventoryFor(60, 20)

    const after: unknown[] = []
    reader.on('tags', (r) => after.push(r))
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(after).toHaveLength(0)
  })
})

describe('selfTest', () => {
  it('says how many of the tags present it actually saw', async () => {
    const reader = new SimulatedRfidReader({ readRate: 0.9, seed: 4 })
    reader.load({ epcs: epcs(20) })

    const report = await reader.selfTest()

    expect(report.outcome).toBe('PASSED')
    expect(report.steps[2]?.detail).toMatch(/of 20 tags/)
    expect(report.steps[2]?.detail).toMatch(/simulation/)
  })
})
