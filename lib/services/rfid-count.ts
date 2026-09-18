import 'server-only'
import { CountStatus, DeviceKind, SerialStatus } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { SimulatedRfidReader } from '@/lib/devices/simulated/rfid-reader'
import { LlrpReader } from '@/lib/devices/server/llrp-reader'
import type { LlrpTagRead } from '@/lib/devices/llrp/protocol'
import { publishTagReads } from '@/lib/events/publish'
import type { AppMode } from '@/lib/mode'
import { countedFromSessionTags, recordTagReads } from './counts'
import { isSimulated } from './devices'
import { splitAddress } from './printing'

/**
 * Sweeping a location with an RFID reader, into an open count session.
 *
 * This is the flagship workflow and the one the whole serial design exists for:
 * a sweep resolves each tag to a physical unit, so the variance is "these two
 * units are missing" rather than "we are two short" (ARCHITECTURE §5.4).
 *
 * The same call drives a real FX9600 and the simulator. Which one is decided by
 * whether the registered reader has a network address, so the demo and the
 * warehouse run the identical code path (WADR-013).
 */

export interface SweepResult {
  device: string
  simulated: boolean
  /** Raw reads this sweep, before de-duplication. */
  reads: number
  /** Distinct tags this sweep. */
  distinctTags: number
  /** Tags this sweep added that the session had not already seen. */
  newToSession: number
  /** Tags already recorded — a re-sweep is free, not an error. */
  duplicates: number
  /** Valid EPCs matching no unit we hold: another site, or never received. */
  unknownEpcs: number
  /** Everything the session has read so far, per item and batch. */
  counted: SweptLine[]
  message: string
}

/**
 * A counted line with enough to display it.
 *
 * Names are resolved here rather than by the client, because a tag may resolve
 * to an item the counting sheet has never heard of — a stray from another aisle
 * — and the sheet has to be able to show it as a row.
 */
export interface SweptLine {
  itemId: string
  batchId: string | null
  quantity: number
  itemSku: string
  itemName: string
  unit: string
  batchNo: string | null
}

/** How long a real reader sweeps for. Long enough for the antenna to cycle. */
const REAL_SWEEP_MS = 3_000

export async function sweepLocation(
  db: PrismaClient,
  sessionId: string,
  options: { deviceId?: string | null; mode: AppMode },
): Promise<SweepResult> {
  const session = await db.countSession.findUnique({
    where: { id: sessionId },
    select: { id: true, status: true, locationId: true, siteId: true },
  })
  if (!session) throw new ApiError(ErrorCode.NOT_FOUND, 'That count session does not exist.')
  if (session.status !== CountStatus.COUNTING) {
    throw new ApiError(
      ErrorCode.SESSION_ALREADY_SUBMITTED,
      'That count is no longer open, so it cannot be swept again.',
    )
  }

  const device = await resolveReader(db, session.siteId, options.deviceId ?? null)

  // The mode decides, before anything about the device does. A demo must never
  // reach a real reader, and a live sweep must never be quietly simulated —
  // it would report stock as present that nobody looked for (DEMO_MODE §7.3).
  const mode = options.mode
  const simulated = mode === 'DEMO'

  if (!simulated && isSimulated(device)) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      `"${device.label}" has no network address, so it cannot sweep anything. Add one under Devices, or switch to Demo mode.`,
    )
  }

  const reads = simulated
    ? await simulatedSweep(db, session.locationId, sessionId)
    : await realSweep(device)

  const outcome = await recordTagReads(
    db,
    sessionId,
    reads.map((read) => ({ epc: read.epc, rssi: read.rssi, readAt: read.at })),
  )

  const distinct = new Set(reads.map((read) => read.epc)).size

  publishTagReads({
    mode,
    siteId: session.siteId,
    sessionId,
    device: device.label,
    simulated,
    distinctTags: distinct,
    newToSession: outcome.accepted,
    unknownEpcs: outcome.unknownEpcs,
  })
  const counted = await describeLines(db, await countedFromSessionTags(db, sessionId))

  return {
    device: device.label,
    simulated,
    reads: reads.length,
    distinctTags: distinct,
    newToSession: outcome.accepted,
    duplicates: outcome.duplicates,
    unknownEpcs: outcome.unknownEpcs,
    counted,
    message: describe(device.label, simulated, distinct, outcome),
  }
}

async function describeLines(
  db: PrismaClient,
  lines: Array<{ itemId: string; batchId: string | null; quantity: number }>,
): Promise<SweptLine[]> {
  if (lines.length === 0) return []

  const [items, batches] = await Promise.all([
    db.item.findMany({
      where: { id: { in: [...new Set(lines.map((line) => line.itemId))] } },
      select: { id: true, sku: true, name: true, unit: true },
    }),
    db.batch.findMany({
      where: {
        id: { in: lines.map((line) => line.batchId).filter((id): id is string => id !== null) },
      },
      select: { id: true, batchNo: true },
    }),
  ])

  const itemById = new Map(items.map((item) => [item.id, item]))
  const batchById = new Map(batches.map((batch) => [batch.id, batch]))

  return lines.map((line) => {
    const item = itemById.get(line.itemId)
    return {
      ...line,
      itemSku: item?.sku ?? '—',
      itemName: item?.name ?? 'Unknown item',
      unit: item?.unit ?? 'units',
      batchNo: line.batchId ? (batchById.get(line.batchId)?.batchNo ?? null) : null,
    }
  })
}

function describe(
  label: string,
  simulated: boolean,
  distinct: number,
  outcome: { accepted: number; unknownEpcs: number },
): string {
  const suffix = simulated ? ' (simulation)' : ''

  if (distinct === 0) {
    return `${label} saw no tags${suffix}. Check that the stock here carries RFID labels, and that the antenna covers this bay.`
  }

  const parts = [
    `${label} saw ${distinct} tag${distinct === 1 ? '' : 's'}${suffix}`,
    outcome.accepted === distinct
      ? ''
      : `, ${outcome.accepted} new to this count`,
  ]

  if (outcome.unknownEpcs > 0) {
    // Worth saying out loud: it is a real finding, not noise.
    parts.push(
      `. ${outcome.unknownEpcs} tag${outcome.unknownEpcs === 1 ? '' : 's'} belong to no unit on record`,
    )
  }

  return `${parts.join('')}.`
}

async function resolveReader(db: PrismaClient, siteId: string, deviceId: string | null) {
  if (deviceId) {
    const device = await db.device.findUnique({ where: { id: deviceId } })
    if (!device || device.kind !== DeviceKind.RFID_READER) {
      throw new ApiError(ErrorCode.NOT_FOUND, 'That reader is not registered.')
    }
    if (!device.active) {
      throw new ApiError(ErrorCode.VALIDATION_FAILED, `"${device.label}" has been retired.`)
    }
    return device
  }

  const device = await db.device.findFirst({
    where: {
      kind: DeviceKind.RFID_READER,
      active: true,
      OR: [{ siteId }, { siteId: null }],
    },
    // A reader belonging to this site wins over an unassigned one.
    orderBy: [{ siteId: 'desc' }, { createdAt: 'asc' }],
  })

  if (!device) {
    throw new ApiError(
      ErrorCode.NOT_FOUND,
      'No RFID reader is set up for this site. Add one under Devices, or count by barcode instead.',
    )
  }

  return device
}

/**
 * A sweep of what is genuinely on the shelf.
 *
 * The EPCs come from the units the projection says are at this location — so
 * the simulator reports on real data and the variance it produces is a real
 * system-versus-shelf difference, not a number written into the database. An
 * earlier version of the seed did write one, and it corrupted the projection.
 */
async function simulatedSweep(
  db: PrismaClient,
  locationId: string,
  sessionId: string,
): Promise<LlrpTagRead[]> {
  const [here, elsewhere, alreadyRead] = await Promise.all([
    db.serialUnit.findMany({
      where: { locationId, status: SerialStatus.IN_STOCK, epc: { not: null } },
      select: { epc: true },
    }),
    // Stock in neighbouring bays that an antenna can overhear. Capped: a few
    // strays are realistic, a flood of them is just noise.
    db.serialUnit.findMany({
      where: {
        locationId: { not: locationId },
        status: SerialStatus.IN_STOCK,
        epc: { not: null },
      },
      select: { epc: true },
      take: 4,
    }),
    db.countTag.count({ where: { sessionId } }),
  ])

  // The FIRST sweep of a session is seeded from its id, so it is reproducible:
  // somebody presenting to a room needs to know what the screen will say before
  // they click. Every sweep after that is random.
  //
  // Seeding later sweeps from the tag count instead looked tidier and was
  // wrong: once a session has read everything in range that count stops
  // changing, so the seed stops changing, and every subsequent sweep returns
  // byte-identical results for ever. A stray the first pass happened to miss
  // could then never be found, however many times you swept.
  const reader = new SimulatedRfidReader({
    label: 'reader',
    seed: alreadyRead === 0 ? hash(sessionId) : Math.floor(Math.random() * 0xffff_ffff),
  })

  reader.load({
    epcs: here.map((unit) => unit.epc!),
    strays: elsewhere.map((unit) => unit.epc!),
  })

  return reader.sweep()
}

async function realSweep(device: { label: string; address: string | null }) {
  const [host, port] = splitAddress(device.address!)
  const reader = new LlrpReader({ host, port, label: device.label })

  try {
    return await reader.inventoryFor(REAL_SWEEP_MS)
  } finally {
    reader.disconnect()
  }
}

function hash(value: string): number {
  let result = 0
  for (let i = 0; i < value.length; i++) {
    result = (Math.imul(result, 31) + value.charCodeAt(i)) | 0
  }
  return Math.abs(result)
}
