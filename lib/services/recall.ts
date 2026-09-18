import 'server-only'
import { SerialStatus } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { traceBatch, type BatchTrace } from './traceability'

/**
 * The recall pack.
 *
 * The question a quality incident actually asks is: "batch LOT-0042 is bad —
 * where is it, where has it been, and what came out of it?" Answering it by
 * clicking through twenty movement screens is how a recall takes a day instead
 * of an hour, and it is the reason batch and serial live in the ledger's grain
 * (WADR-018).
 *
 * This assembles the whole answer in one call, and it is deliberately BLUNT
 * about what it does not know. A recall pack that quietly omits the units it
 * could not account for is worse than no pack: somebody signs it off believing
 * the batch is contained.
 */

export interface RecallLine {
  section: 'ON HAND' | 'MOVEMENT' | 'UNIT' | 'UNACCOUNTED'
  reference: string
  detail: string
  quantity: number | null
  at: Date | null
  who: string | null
}

export interface RecallPack {
  batch: BatchTrace['batch']
  generatedAt: Date
  /** Everything still on a shelf, and where. */
  onHand: number
  locations: BatchTrace['locations']
  movements: BatchTrace['movements']
  units: BatchTrace['units']
  /**
   * Units this batch produced that are no longer in stock.
   *
   * Named separately because they are the ones that left the building. On a
   * recall these are the rows somebody has to make phone calls about.
   */
  issued: BatchTrace['units']
  /**
   * The arithmetic that says whether the pack is complete.
   *
   * Received minus issued minus scrapped should equal what is on hand. When it
   * does not, something happened that the ledger does not explain, and the
   * discrepancy is reported rather than smoothed over.
   */
  reconciliation: {
    received: number
    issued: number
    scrapped: number
    adjusted: number
    expectedOnHand: number
    actualOnHand: number
    balanced: boolean
  }
  lines: RecallLine[]
}

export async function buildRecallPack(
  db: PrismaClient,
  batchId: string,
  now: Date = new Date(),
): Promise<RecallPack> {
  const trace = await traceBatch(db, batchId, now)
  if (!trace) throw new ApiError(ErrorCode.NOT_FOUND, 'That batch does not exist.')

  const onHand = trace.locations.reduce((sum, location) => sum + location.quantity, 0)

  const totals = { received: 0, issued: 0, scrapped: 0, adjusted: 0 }
  for (const movement of trace.movements) {
    if (movement.type === 'RECEIVE') totals.received += movement.quantity
    else if (movement.type === 'ISSUE') totals.issued += movement.quantity
    else if (movement.type === 'SCRAP') totals.scrapped += movement.quantity
    else if (movement.type === 'ADJUST' || movement.type === 'COUNT') {
      // A correction can go either way, and its sign is already in the ledger.
      totals.adjusted += movement.to ? movement.quantity : -movement.quantity
    }
    // MOVE is deliberately absent: it changes where stock is, not how much.
  }

  const expectedOnHand = totals.received - totals.issued - totals.scrapped + totals.adjusted
  const issued = trace.units.filter((unit) => unit.status !== SerialStatus.IN_STOCK)

  const reconciliation = {
    ...totals,
    expectedOnHand,
    actualOnHand: onHand,
    balanced: expectedOnHand === onHand,
  }

  return {
    batch: trace.batch,
    generatedAt: now,
    onHand,
    locations: trace.locations,
    movements: trace.movements,
    units: trace.units,
    issued,
    reconciliation,
    lines: flatten(trace, reconciliation, issued),
  }
}

/**
 * One flat list, for the CSV.
 *
 * A recall pack is passed to people who do not have the system open — a quality
 * manager, a customer, sometimes a regulator — so it has to survive as a single
 * sheet rather than as four linked tables.
 */
function flatten(
  trace: BatchTrace,
  reconciliation: RecallPack['reconciliation'],
  issued: BatchTrace['units'],
): RecallLine[] {
  const lines: RecallLine[] = []

  for (const location of trace.locations) {
    lines.push({
      section: 'ON HAND',
      reference: location.code,
      detail: location.name,
      quantity: location.quantity,
      at: null,
      who: null,
    })
  }

  for (const movement of trace.movements) {
    lines.push({
      section: 'MOVEMENT',
      reference: movement.docNo,
      detail: [movement.type, movement.from && `from ${movement.from}`, movement.to && `to ${movement.to}`]
        .filter(Boolean)
        .join(' '),
      quantity: movement.quantity,
      at: movement.occurredAt,
      who: movement.user,
    })
  }

  for (const unit of trace.units) {
    lines.push({
      section: unit.status === SerialStatus.IN_STOCK ? 'UNIT' : 'UNACCOUNTED',
      reference: unit.serialNo,
      detail:
        unit.status === SerialStatus.IN_STOCK
          ? `in stock${unit.location ? ` at ${unit.location}` : ''}`
          : `${unit.status.toLowerCase()} — no longer in stock`,
      quantity: 1,
      at: null,
      who: null,
    })
  }

  if (!reconciliation.balanced) {
    // Stated as a line of the pack, not a footnote. Somebody signing this off
    // has to see that the arithmetic does not close.
    lines.push({
      section: 'UNACCOUNTED',
      reference: 'RECONCILIATION',
      detail: `The ledger accounts for ${reconciliation.expectedOnHand} but ${reconciliation.actualOnHand} is on hand. Investigate before relying on this pack.`,
      quantity: reconciliation.expectedOnHand - reconciliation.actualOnHand,
      at: null,
      who: null,
    })
  }

  if (issued.length > 0) {
    lines.push({
      section: 'UNACCOUNTED',
      reference: 'SUMMARY',
      detail: `${issued.length} unit${issued.length === 1 ? '' : 's'} from this batch have left stock and need to be traced outside the system.`,
      quantity: issued.length,
      at: null,
      who: null,
    })
  }

  return lines
}
