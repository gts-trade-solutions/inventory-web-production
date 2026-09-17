import { describe, expect, it } from 'vitest'
import { batchStockAt, projectStock, quantityAt, stockAt, totalOnHand } from './stock'
import { MovementType, NO_BATCH, type Movement } from './types'
import {
  ADHESIVE,
  AISLE_A,
  AISLE_B,
  FRESH_BATCH,
  GLOVES,
  SOON_BATCH,
  TAPE,
  movement,
  receipt,
} from './fixtures'

/**
 * Ported from the mobile app's StockProjectionTest.kt, plus the batch-grain
 * cases the traceability model adds.
 *
 * This is the definition the `stock_levels` table has to agree with: the rebuild
 * job recomputes it from here, and the nightly drift check compares the two
 * (ARCHITECTURE §4.3).
 */

describe('projectStock', () => {
  // Ported verbatim from StockProjectionTest.receiptsIssuesAndMovesNetOutPerLocation
  it('nets receipts, issues and moves out per location', () => {
    const ledger: Movement[] = [
      receipt(20, AISLE_A),
      movement({ id: 'm2', type: MovementType.ISSUE, quantity: 5, fromLocationId: AISLE_A.id }),
      movement({
        id: 'm3',
        type: MovementType.MOVE,
        quantity: 8,
        fromLocationId: AISLE_A.id,
        toLocationId: AISLE_B.id,
      }),
    ]

    expect(new Set(projectStock(ledger))).toEqual(
      new Set([
        { itemId: TAPE.id, locationId: AISLE_A.id, batchKey: NO_BATCH, quantity: 7 },
        { itemId: TAPE.id, locationId: AISLE_B.id, batchKey: NO_BATCH, quantity: 8 },
      ]),
    )
    expect(quantityAt(ledger, TAPE.id, AISLE_A.id)).toBe(7)
    expect(quantityAt(ledger, TAPE.id, AISLE_B.id)).toBe(8)
  })

  // Ported from StockProjectionTest.locationsThatNetToZeroAreLeftOut
  it('leaves out locations that net to zero', () => {
    const ledger: Movement[] = [
      receipt(4),
      movement({ id: 'm2', type: MovementType.ISSUE, quantity: 4, fromLocationId: AISLE_A.id }),
    ]

    expect(projectStock(ledger)).toEqual([])
  })

  it('keeps negative rows, because they are the exception queue', () => {
    // An offline over-issue is accepted and flagged rather than rejected
    // (WADR-007). Dropping the row would hide the thing a supervisor must see.
    const ledger: Movement[] = [
      receipt(2),
      movement({ id: 'm2', type: MovementType.ISSUE, quantity: 5, fromLocationId: AISLE_A.id }),
    ]

    expect(projectStock(ledger)).toEqual([
      { itemId: TAPE.id, locationId: AISLE_A.id, batchKey: NO_BATCH, quantity: -3 },
    ])
  })

  it('is empty for an empty ledger', () => {
    expect(projectStock([])).toEqual([])
  })

  it('separates batches of the same item in the same location', () => {
    const ledger: Movement[] = [
      receipt(10, AISLE_A, ADHESIVE, FRESH_BATCH.id),
      receipt(4, AISLE_A, ADHESIVE, SOON_BATCH.id),
    ]

    const levels = projectStock(ledger)

    expect(levels).toHaveLength(2)
    expect(levels.find((l) => l.batchKey === FRESH_BATCH.id)?.quantity).toBe(10)
    expect(levels.find((l) => l.batchKey === SOON_BATCH.id)?.quantity).toBe(4)
  })
})

describe('quantityAt', () => {
  it('sums across batches when no batch is given', () => {
    const ledger: Movement[] = [
      receipt(10, AISLE_A, ADHESIVE, FRESH_BATCH.id),
      receipt(4, AISLE_A, ADHESIVE, SOON_BATCH.id),
    ]

    expect(quantityAt(ledger, ADHESIVE.id, AISLE_A.id)).toBe(14)
  })

  it('restricts to one batch when given one', () => {
    const ledger: Movement[] = [
      receipt(10, AISLE_A, ADHESIVE, FRESH_BATCH.id),
      receipt(4, AISLE_A, ADHESIVE, SOON_BATCH.id),
    ]

    expect(quantityAt(ledger, ADHESIVE.id, AISLE_A.id, FRESH_BATCH.id)).toBe(10)
    expect(quantityAt(ledger, ADHESIVE.id, AISLE_A.id, SOON_BATCH.id)).toBe(4)
  })

  it('ignores other items and other locations', () => {
    const ledger: Movement[] = [receipt(10, AISLE_A, TAPE), receipt(7, AISLE_B, GLOVES)]

    expect(quantityAt(ledger, TAPE.id, AISLE_B.id)).toBe(0)
    expect(quantityAt(ledger, GLOVES.id, AISLE_A.id)).toBe(0)
  })

  it('counts a move as out of one location and into the other', () => {
    const ledger: Movement[] = [
      receipt(10),
      movement({
        id: 'm2',
        type: MovementType.MOVE,
        quantity: 4,
        fromLocationId: AISLE_A.id,
        toLocationId: AISLE_B.id,
      }),
    ]

    expect(quantityAt(ledger, TAPE.id, AISLE_A.id)).toBe(6)
    expect(quantityAt(ledger, TAPE.id, AISLE_B.id)).toBe(4)
  })
})

describe('stockAt', () => {
  it('returns on-hand per item at a location, summed across batches', () => {
    const ledger: Movement[] = [
      receipt(10, AISLE_A, ADHESIVE, FRESH_BATCH.id),
      receipt(4, AISLE_A, ADHESIVE, SOON_BATCH.id),
      receipt(3, AISLE_A, TAPE),
      receipt(99, AISLE_B, GLOVES),
    ]

    expect(stockAt(ledger, AISLE_A.id)).toEqual(
      new Map([
        [ADHESIVE.id, 14],
        [TAPE.id, 3],
      ]),
    )
  })

  it('drops an item whose batches cancel to zero overall', () => {
    // One batch +5, another -5: every individual row is non-zero, so only the
    // sum reveals there is nothing there.
    const ledger: Movement[] = [
      receipt(5, AISLE_A, ADHESIVE, FRESH_BATCH.id),
      movement({
        id: 'm2',
        itemId: ADHESIVE.id,
        type: MovementType.ISSUE,
        quantity: 5,
        batchId: SOON_BATCH.id,
        fromLocationId: AISLE_A.id,
      }),
    ]

    expect(stockAt(ledger, AISLE_A.id).has(ADHESIVE.id)).toBe(false)
  })
})

describe('batchStockAt', () => {
  it('returns on-hand per batch for one item at a location', () => {
    const ledger: Movement[] = [
      receipt(10, AISLE_A, ADHESIVE, FRESH_BATCH.id),
      receipt(4, AISLE_A, ADHESIVE, SOON_BATCH.id),
      receipt(6, AISLE_B, ADHESIVE, FRESH_BATCH.id),
    ]

    expect(batchStockAt(ledger, ADHESIVE.id, AISLE_A.id)).toEqual(
      new Map([
        [FRESH_BATCH.id, 10],
        [SOON_BATCH.id, 4],
      ]),
    )
  })
})

describe('totalOnHand', () => {
  it('sums an item across every location and batch', () => {
    const ledger: Movement[] = [
      receipt(10, AISLE_A, ADHESIVE, FRESH_BATCH.id),
      receipt(4, AISLE_B, ADHESIVE, SOON_BATCH.id),
      receipt(100, AISLE_A, TAPE),
    ]

    expect(totalOnHand(ledger, ADHESIVE.id)).toBe(14)
  })
})
