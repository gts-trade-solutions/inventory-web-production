import { EventEmitter } from 'node:events'
import type { SelfTestReport } from '../printer'
import type { LlrpTagRead } from '../llrp/protocol'

/**
 * An RFID reader that exists only in memory.
 *
 * Mirrors the mobile app's simulated reader, and matters more than the other
 * simulators: an RFID cycle count is the flagship workflow, and without this
 * nobody could see it work before the hardware arrives (DEMO_MODE §3).
 *
 * It is deliberately IMPERFECT. A reader that returns every tag every time
 * would make every count come out exact, which would teach an operator that a
 * clean count is normal and a variance means something is broken. Real readers
 * miss tags at the back of a shelf, read the same tag dozens of times per
 * sweep, and pick up strays from the next aisle. The demo shows all three.
 *
 * Crucially this produces a genuine SYSTEM-VERSUS-SHELF difference, the way a
 * real count does. It does not write a fake variance into the database — an
 * earlier version of the seed did that, and it corrupted the projection.
 */

export interface SimulatedRfidOptions {
  label?: string
  /**
   * Share of in-range tags a sweep sees. 1 means a perfect reader.
   *
   * 0.92 is deliberately imperfect but not alarming: a 25-unit bin usually
   * comes back one or two short, which is what a real cycle count looks like.
   */
  readRate?: number
  /** Times a tag is seen per sweep, before de-duplication. */
  readsPerTag?: number
  /** Deterministic runs, so a demo can be rehearsed. */
  seed?: number
}

export interface SimulatedTagSource {
  /** EPCs physically present in front of the antenna. */
  epcs: readonly string[]
  /** EPCs from neighbouring stock the antenna also picks up. */
  strays?: readonly string[]
}

const DEFAULT_READ_RATE = 0.92
const DEFAULT_READS_PER_TAG = 3

export class SimulatedRfidReader extends EventEmitter {
  readonly simulated = true
  readonly label: string

  private readonly readRate: number
  private readonly readsPerTag: number
  private random: () => number
  private timer: NodeJS.Timeout | null = null
  private source: SimulatedTagSource = { epcs: [] }

  constructor(options: SimulatedRfidOptions = {}) {
    super()
    this.label = options.label ?? 'Simulated RFID reader'
    this.readRate = clamp(options.readRate ?? DEFAULT_READ_RATE, 0, 1)
    this.readsPerTag = Math.max(options.readsPerTag ?? DEFAULT_READS_PER_TAG, 1)
    this.random = mulberry32(options.seed ?? 0x5eed)
  }

  get connected(): boolean {
    return true
  }

  /** What is physically in front of the antenna. */
  load(source: SimulatedTagSource): void {
    this.source = source
  }

  /** One pass of the antenna. */
  sweep(now: Date = new Date()): LlrpTagRead[] {
    const reads: LlrpTagRead[] = []

    for (const epc of this.source.epcs) {
      if (this.random() > this.readRate) continue // Missed: at the back of the shelf.

      const times = 1 + Math.floor(this.random() * this.readsPerTag)
      for (let i = 0; i < times; i++) {
        reads.push({
          epc: epc.toUpperCase(),
          antenna: 1 + Math.floor(this.random() * 4),
          // Strong reads near the antenna, weak ones further back.
          rssi: -35 - Math.floor(this.random() * 30),
          at: new Date(now.getTime() + reads.length),
        })
      }
    }

    // Strays read far more weakly, which is how an operator tells them apart.
    for (const epc of this.source.strays ?? []) {
      if (this.random() > 0.25) continue
      reads.push({
        epc: epc.toUpperCase(),
        antenna: 1 + Math.floor(this.random() * 4),
        rssi: -70 - Math.floor(this.random() * 15),
        at: new Date(now.getTime() + reads.length),
      })
    }

    return reads
  }

  /** Sweeps repeatedly, emitting `tags`, the way a real reader streams. */
  startInventory(intervalMs = 250): void {
    this.stopInventory()
    this.timer = setInterval(() => {
      const reads = this.sweep()
      if (reads.length > 0) this.emit('tags', reads)
    }, intervalMs)
  }

  stopInventory(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async inventoryFor(ms: number, intervalMs = 100): Promise<LlrpTagRead[]> {
    const collected: LlrpTagRead[] = []
    const collect = (reads: LlrpTagRead[]) => collected.push(...reads)

    this.on('tags', collect)
    this.startInventory(intervalMs)
    await new Promise((resolve) => setTimeout(resolve, ms))
    this.stopInventory()
    this.off('tags', collect)

    return collected
  }

  disconnect(): void {
    this.stopInventory()
  }

  async selfTest(): Promise<SelfTestReport> {
    const reads = this.sweep()
    const unique = new Set(reads.map((read) => read.epc))

    return {
      device: this.label,
      ok: true,
      steps: [
        { name: 'Connect', ok: true, detail: 'Simulated reader — no network involved.', ms: 0 },
        {
          name: 'Read capabilities',
          ok: true,
          detail: 'Simulated FX9600, 4 antennas.',
          ms: 0,
        },
        {
          name: 'Inventory sweep',
          ok: true,
          detail: `Saw ${unique.size} of ${this.source.epcs.length} tags in ${reads.length} reads (simulation).`,
          ms: 0,
        },
      ],
    }
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high)
}

/**
 * A small seeded generator.
 *
 * Seeded on purpose: a demo that produces a different variance every run cannot
 * be rehearsed, and somebody presenting to a room needs to know what the screen
 * will say before they click.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
