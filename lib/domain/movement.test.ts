import { describe, expect, it } from 'vitest'
import {
  MovementErrorCode,
  isExpired,
  isNearExpiry,
  planMovement,
  proposeBatchFefo,
  type StockAction,
} from './movement'
import { MovementType, SerialStatus } from './types'
import {
  ADHESIVE,
  AISLE_A,
  AISLE_B,
  DRILL,
  EXPIRED_BATCH,
  FRESH_BATCH,
  NOW,
  QUARANTINED_BATCH,
  SOON_BATCH,
  TAPE,
  WARN_EXPIRED,
  context,
  receipt,
  serialUnit,
} from './fixtures'

/**
 * Ported from the mobile app's RecordMovementTest.kt, then extended for batch,
 * serial and expiry.
 *
 * The Kotlin cases are marked. They are the contract the two clients share: if
 * one of these changes behaviour here, the phone and the web disagree about what
 * a movement means, which is the failure WADR-004 exists to prevent.
 */

const plan = (action: StockAction, ctx = context()) => planMovement(action, ctx)

const expectRejected = (decision: ReturnType<typeof planMovement>, code: MovementErrorCode) => {
  expect(decision.ok).toBe(false)
  if (!decision.ok) expect(decision.error.code).toBe(code)
}

const expectPlanned = (decision: ReturnType<typeof planMovement>) => {
  expect(decision.ok).toBe(true)
  if (!decision.ok) throw new Error(`Expected a plan, got ${decision.error.code}`)
  return decision.movement
}

describe('untracked items — ported from RecordMovementTest.kt', () => {
  // RecordMovementTest.receiveAppendsLedgerEntryAndRaisesStock
  it('plans a receipt and trims the note', () => {
    const movement = expectPlanned(
      plan({
        kind: 'RECEIVE',
        itemId: TAPE.id,
        toLocationId: AISLE_A.id,
        quantity: 24,
        note: '  PO-4417 ',
      }),
    )

    expect(movement.type).toBe(MovementType.RECEIVE)
    expect(movement.quantity).toBe(24)
    expect(movement.toLocationId).toBe(AISLE_A.id)
    expect(movement.fromLocationId).toBeNull()
    expect(movement.note).toBe('PO-4417')
  })

  it('treats a whitespace-only note as no note', () => {
    const movement = expectPlanned(
      plan({
        kind: 'RECEIVE',
        itemId: TAPE.id,
        toLocationId: AISLE_A.id,
        quantity: 1,
        note: '   ',
      }),
    )
    expect(movement.note).toBeNull()
  })

  // RecordMovementTest.issueCannotTakeMoreThanIsAtTheSource
  it('refuses to issue more than is at the source', () => {
    const decision = plan(
      { kind: 'ISSUE', itemId: TAPE.id, fromLocationId: AISLE_A.id, quantity: 5 },
      context({ ledger: [receipt(3)] }),
    )

    expectRejected(decision, MovementErrorCode.INSUFFICIENT_STOCK)
    if (!decision.ok) expect(decision.error.details?.available).toBe(3)
  })

  it('allows issuing exactly what is there', () => {
    const movement = expectPlanned(
      plan(
        { kind: 'ISSUE', itemId: TAPE.id, fromLocationId: AISLE_A.id, quantity: 3 },
        context({ ledger: [receipt(3)] }),
      ),
    )
    expect(movement.quantity).toBe(3)
  })

  // RecordMovementTest.moveTransfersStockBetweenLocations
  it('plans a move between locations', () => {
    const movement = expectPlanned(
      plan(
        {
          kind: 'MOVE',
          itemId: TAPE.id,
          fromLocationId: AISLE_A.id,
          toLocationId: AISLE_B.id,
          quantity: 4,
        },
        context({ ledger: [receipt(10)] }),
      ),
    )

    expect(movement.fromLocationId).toBe(AISLE_A.id)
    expect(movement.toLocationId).toBe(AISLE_B.id)
  })

  // RecordMovementTest.moveToTheSameLocationIsRejected
  it('rejects a move to the same location', () => {
    expectRejected(
      plan(
        {
          kind: 'MOVE',
          itemId: TAPE.id,
          fromLocationId: AISLE_A.id,
          toLocationId: AISLE_A.id,
          quantity: 1,
        },
        context({ ledger: [receipt(10)] }),
      ),
      MovementErrorCode.SAME_LOCATION,
    )
  })

  // RecordMovementTest.quantityMustBePositive
  it('requires a positive whole quantity', () => {
    for (const quantity of [0, -1, 1.5, Number.NaN]) {
      expectRejected(
        plan({ kind: 'RECEIVE', itemId: TAPE.id, toLocationId: AISLE_A.id, quantity }),
        MovementErrorCode.INVALID_QUANTITY,
      )
    }
  })

  // RecordMovementTest.adjustDownRecordsTheDifferenceOutOfTheLocation
  it('records an adjustment down as the difference leaving the location', () => {
    const movement = expectPlanned(
      plan(
        {
          kind: 'ADJUST',
          itemId: TAPE.id,
          locationId: AISLE_A.id,
          countedQuantity: 7,
          reasonCodeId: 'reason-damage',
        },
        context({ ledger: [receipt(10)] }),
      ),
    )

    expect(movement.type).toBe(MovementType.ADJUST)
    // The ledger stores the DIFFERENCE, not the counted total.
    expect(movement.quantity).toBe(3)
    expect(movement.fromLocationId).toBe(AISLE_A.id)
    expect(movement.toLocationId).toBeNull()
  })

  it('records an adjustment up as the difference arriving', () => {
    const movement = expectPlanned(
      plan(
        {
          kind: 'ADJUST',
          itemId: TAPE.id,
          locationId: AISLE_A.id,
          countedQuantity: 14,
          reasonCodeId: 'reason-found',
        },
        context({ ledger: [receipt(10)] }),
      ),
    )

    expect(movement.quantity).toBe(4)
    expect(movement.toLocationId).toBe(AISLE_A.id)
    expect(movement.fromLocationId).toBeNull()
  })

  // RecordMovementTest.adjustNeedsAReasonAndAnActualChange
  it('needs a reason code and an actual change', () => {
    const ledger = [receipt(10)]

    expectRejected(
      plan(
        {
          kind: 'ADJUST',
          itemId: TAPE.id,
          locationId: AISLE_A.id,
          countedQuantity: 7,
          reasonCodeId: '  ',
        },
        context({ ledger }),
      ),
      MovementErrorCode.REASON_CODE_REQUIRED,
    )

    expectRejected(
      plan(
        {
          kind: 'ADJUST',
          itemId: TAPE.id,
          locationId: AISLE_A.id,
          countedQuantity: 10,
          reasonCodeId: 'reason-recount',
        },
        context({ ledger }),
      ),
      MovementErrorCode.NO_CHANGE,
    )
  })

  it('allows adjusting down to zero but not below', () => {
    const ledger = [receipt(10)]

    expect(
      expectPlanned(
        plan(
          {
            kind: 'ADJUST',
            itemId: TAPE.id,
            locationId: AISLE_A.id,
            countedQuantity: 0,
            reasonCodeId: 'r',
          },
          context({ ledger }),
        ),
      ).quantity,
    ).toBe(10)

    expectRejected(
      plan(
        {
          kind: 'ADJUST',
          itemId: TAPE.id,
          locationId: AISLE_A.id,
          countedQuantity: -1,
          reasonCodeId: 'r',
        },
        context({ ledger }),
      ),
      MovementErrorCode.INVALID_QUANTITY,
    )
  })

  // RecordMovementTest.unknownItemOrLocationIsRejected
  it('rejects an unknown item or location', () => {
    expectRejected(
      plan({ kind: 'RECEIVE', itemId: 'missing', toLocationId: AISLE_A.id, quantity: 1 }),
      MovementErrorCode.UNKNOWN_ITEM,
    )
    expectRejected(
      plan({ kind: 'RECEIVE', itemId: TAPE.id, toLocationId: 'nowhere', quantity: 1 }),
      MovementErrorCode.UNKNOWN_LOCATION,
    )
  })
})

describe('scrap', () => {
  it('needs a reason code and removes stock', () => {
    const ctx = context({ ledger: [receipt(10)] })

    expectRejected(
      plan(
        {
          kind: 'SCRAP',
          itemId: TAPE.id,
          fromLocationId: AISLE_A.id,
          quantity: 2,
          reasonCodeId: '',
        },
        ctx,
      ),
      MovementErrorCode.REASON_CODE_REQUIRED,
    )

    const movement = expectPlanned(
      plan(
        {
          kind: 'SCRAP',
          itemId: TAPE.id,
          fromLocationId: AISLE_A.id,
          quantity: 2,
          reasonCodeId: 'r-broken',
        },
        ctx,
      ),
    )
    expect(movement.type).toBe(MovementType.SCRAP)
    expect(movement.toLocationId).toBeNull()
  })
})

describe('batch-tracked items', () => {
  const batchCtx = (overrides = {}) =>
    context({
      item: ADHESIVE,
      batches: [FRESH_BATCH, SOON_BATCH, EXPIRED_BATCH, QUARANTINED_BATCH],
      ...overrides,
    })

  it('requires a batch', () => {
    expectRejected(
      plan(
        { kind: 'RECEIVE', itemId: ADHESIVE.id, toLocationId: AISLE_A.id, quantity: 5 },
        batchCtx(),
      ),
      MovementErrorCode.BATCH_REQUIRED,
    )
  })

  it('rejects a batch that does not exist or belongs to another item', () => {
    expectRejected(
      plan(
        {
          kind: 'RECEIVE',
          itemId: ADHESIVE.id,
          toLocationId: AISLE_A.id,
          quantity: 5,
          batchId: 'nope',
        },
        batchCtx(),
      ),
      MovementErrorCode.UNKNOWN_BATCH,
    )
  })

  it('counts stock per batch, not per item', () => {
    const ledger = [receipt(10, AISLE_A, ADHESIVE, FRESH_BATCH.id)]

    // 10 of FRESH exist, but none of SOON — the item total must not rescue it.
    expectRejected(
      plan(
        {
          kind: 'ISSUE',
          itemId: ADHESIVE.id,
          fromLocationId: AISLE_A.id,
          quantity: 1,
          batchId: SOON_BATCH.id,
        },
        batchCtx({ ledger }),
      ),
      MovementErrorCode.INSUFFICIENT_STOCK,
    )
  })

  it('blocks issuing an expired batch by default', () => {
    const ledger = [receipt(10, AISLE_A, ADHESIVE, EXPIRED_BATCH.id)]

    expectRejected(
      plan(
        {
          kind: 'ISSUE',
          itemId: ADHESIVE.id,
          fromLocationId: AISLE_A.id,
          quantity: 1,
          batchId: EXPIRED_BATCH.id,
        },
        batchCtx({ ledger }),
      ),
      MovementErrorCode.BATCH_EXPIRED,
    )
  })

  it('allows an expired issue where site policy is WARN', () => {
    const ledger = [receipt(10, AISLE_A, ADHESIVE, EXPIRED_BATCH.id)]

    expectPlanned(
      plan(
        {
          kind: 'ISSUE',
          itemId: ADHESIVE.id,
          fromLocationId: AISLE_A.id,
          quantity: 1,
          batchId: EXPIRED_BATCH.id,
        },
        batchCtx({ ledger, policy: WARN_EXPIRED }),
      ),
    )
  })

  it('allows a supervisor override of an expired issue', () => {
    const ledger = [receipt(10, AISLE_A, ADHESIVE, EXPIRED_BATCH.id)]

    expectPlanned(
      plan(
        {
          kind: 'ISSUE',
          itemId: ADHESIVE.id,
          fromLocationId: AISLE_A.id,
          quantity: 1,
          batchId: EXPIRED_BATCH.id,
        },
        batchCtx({ ledger, allowExpiredOverride: true }),
      ),
    )
  })

  it('still allows moving and scrapping expired stock', () => {
    // Quarantining expired stock in another bin, then scrapping it, is exactly
    // how you deal with it — blocking either would trap it in place.
    const ledger = [receipt(10, AISLE_A, ADHESIVE, EXPIRED_BATCH.id)]

    expectPlanned(
      plan(
        {
          kind: 'MOVE',
          itemId: ADHESIVE.id,
          fromLocationId: AISLE_A.id,
          toLocationId: AISLE_B.id,
          quantity: 1,
          batchId: EXPIRED_BATCH.id,
        },
        batchCtx({ ledger }),
      ),
    )

    expectPlanned(
      plan(
        {
          kind: 'SCRAP',
          itemId: ADHESIVE.id,
          fromLocationId: AISLE_A.id,
          quantity: 1,
          batchId: EXPIRED_BATCH.id,
          reasonCodeId: 'r-expired',
        },
        batchCtx({ ledger }),
      ),
    )
  })

  it('blocks a quarantined batch in every direction out', () => {
    const ledger = [receipt(10, AISLE_A, ADHESIVE, QUARANTINED_BATCH.id)]

    expectRejected(
      plan(
        {
          kind: 'ISSUE',
          itemId: ADHESIVE.id,
          fromLocationId: AISLE_A.id,
          quantity: 1,
          batchId: QUARANTINED_BATCH.id,
        },
        batchCtx({ ledger }),
      ),
      MovementErrorCode.BATCH_BLOCKED,
    )
  })

  it('allows receiving into a batch that has nothing in it yet', () => {
    expectPlanned(
      plan(
        {
          kind: 'RECEIVE',
          itemId: ADHESIVE.id,
          toLocationId: AISLE_A.id,
          quantity: 5,
          batchId: FRESH_BATCH.id,
        },
        batchCtx(),
      ),
    )
  })
})

describe('serial-tracked items', () => {
  const unitA = serialUnit({ id: 'unit-a' })
  const unitB = serialUnit({ id: 'unit-b' })
  const unitAtB = serialUnit({ id: 'unit-c', locationId: AISLE_B.id })
  const issuedUnit = serialUnit({ id: 'unit-d', status: SerialStatus.ISSUED, locationId: null })

  const serialCtx = (overrides = {}) =>
    context({
      item: DRILL,
      serials: [unitA, unitB, unitAtB, issuedUnit],
      ledger: [receipt(3, AISLE_A, DRILL)],
      ...overrides,
    })

  it('requires serial numbers', () => {
    expectRejected(
      plan(
        { kind: 'ISSUE', itemId: DRILL.id, fromLocationId: AISLE_A.id, quantity: 1 },
        serialCtx(),
      ),
      MovementErrorCode.SERIALS_REQUIRED,
    )
  })

  it('requires exactly one unit per quantity', () => {
    // A mismatch means the caller has miscounted what it is holding. It must
    // fail loudly rather than pick a number to trust.
    expectRejected(
      plan(
        {
          kind: 'ISSUE',
          itemId: DRILL.id,
          fromLocationId: AISLE_A.id,
          quantity: 2,
          serialUnitIds: [unitA.id],
        },
        serialCtx(),
      ),
      MovementErrorCode.SERIAL_COUNT_MISMATCH,
    )
  })

  it('rejects the same unit listed twice', () => {
    expectRejected(
      plan(
        {
          kind: 'ISSUE',
          itemId: DRILL.id,
          fromLocationId: AISLE_A.id,
          quantity: 2,
          serialUnitIds: [unitA.id, unitA.id],
        },
        serialCtx(),
      ),
      MovementErrorCode.SERIAL_COUNT_MISMATCH,
    )
  })

  it('rejects a unit that is not on record', () => {
    expectRejected(
      plan(
        {
          kind: 'ISSUE',
          itemId: DRILL.id,
          fromLocationId: AISLE_A.id,
          quantity: 1,
          serialUnitIds: ['ghost'],
        },
        serialCtx(),
      ),
      MovementErrorCode.UNKNOWN_SERIAL,
    )
  })

  it('rejects a unit that is somewhere else', () => {
    expectRejected(
      plan(
        {
          kind: 'ISSUE',
          itemId: DRILL.id,
          fromLocationId: AISLE_A.id,
          quantity: 1,
          serialUnitIds: [unitAtB.id],
        },
        serialCtx(),
      ),
      MovementErrorCode.SERIAL_NOT_AT_LOCATION,
    )
  })

  it('rejects a unit that has already been issued', () => {
    // The offline version of this is a SERIAL_CONFLICT: two devices issuing the
    // same physical unit, which arithmetic cannot reconcile (WADR-020).
    expectRejected(
      plan(
        {
          kind: 'ISSUE',
          itemId: DRILL.id,
          fromLocationId: AISLE_A.id,
          quantity: 1,
          serialUnitIds: [issuedUnit.id],
        },
        serialCtx(),
      ),
      MovementErrorCode.SERIAL_ALREADY_ISSUED,
    )
  })

  it('plans an issue of named units', () => {
    const movement = expectPlanned(
      plan(
        {
          kind: 'ISSUE',
          itemId: DRILL.id,
          fromLocationId: AISLE_A.id,
          quantity: 2,
          serialUnitIds: [unitA.id, unitB.id],
        },
        serialCtx(),
      ),
    )

    expect(movement.serialUnitIds).toEqual([unitA.id, unitB.id])
    expect(movement.quantity).toBe(2)
  })

  it('plans a move of named units', () => {
    const movement = expectPlanned(
      plan(
        {
          kind: 'MOVE',
          itemId: DRILL.id,
          fromLocationId: AISLE_A.id,
          toLocationId: AISLE_B.id,
          quantity: 1,
          serialUnitIds: [unitA.id],
        },
        serialCtx(),
      ),
    )

    expect(movement.serialUnitIds).toEqual([unitA.id])
    expect(movement.toLocationId).toBe(AISLE_B.id)
  })

  describe('receiving', () => {
    it('requires a serial number per unit', () => {
      expectRejected(
        plan(
          { kind: 'RECEIVE', itemId: DRILL.id, toLocationId: AISLE_A.id, quantity: 2 },
          serialCtx(),
        ),
        MovementErrorCode.SERIALS_REQUIRED,
      )
    })

    it('requires the serial count to match the quantity', () => {
      expectRejected(
        plan(
          {
            kind: 'RECEIVE',
            itemId: DRILL.id,
            toLocationId: AISLE_A.id,
            quantity: 3,
            serialUnitIds: ['new-1', 'new-2'],
          },
          serialCtx(),
        ),
        MovementErrorCode.SERIAL_COUNT_MISMATCH,
      )
    })

    it('rejects the same new unit listed twice', () => {
      expectRejected(
        plan(
          {
            kind: 'RECEIVE',
            itemId: DRILL.id,
            toLocationId: AISLE_A.id,
            quantity: 2,
            serialUnitIds: ['new-1', 'new-1'],
          },
          serialCtx(),
        ),
        MovementErrorCode.SERIAL_COUNT_MISMATCH,
      )
    })

    it('plans a receipt that creates the named units', () => {
      const movement = expectPlanned(
        plan(
          {
            kind: 'RECEIVE',
            itemId: DRILL.id,
            toLocationId: AISLE_A.id,
            quantity: 2,
            serialUnitIds: ['new-1', 'new-2'],
          },
          serialCtx(),
        ),
      )

      expect(movement.serialUnitIds).toEqual(['new-1', 'new-2'])
      expect(movement.toLocationId).toBe(AISLE_A.id)
    })
  })

  describe('units that belong to a batch', () => {
    const fromFresh = serialUnit({ id: 'unit-fresh', batchId: FRESH_BATCH.id })
    const fromSoon = serialUnit({ id: 'unit-soon', batchId: SOON_BATCH.id })
    const fromExpired = serialUnit({ id: 'unit-expired', batchId: EXPIRED_BATCH.id })
    const fromQuarantine = serialUnit({ id: 'unit-quar', batchId: QUARANTINED_BATCH.id })

    const batchedSerialCtx = () =>
      context({
        item: DRILL,
        serials: [fromFresh, fromSoon, fromExpired, fromQuarantine],
        batches: [FRESH_BATCH, SOON_BATCH, EXPIRED_BATCH, QUARANTINED_BATCH],
        ledger: [receipt(4, AISLE_A, DRILL)],
      })

    it('carries the batch through when every unit shares one', () => {
      const movement = expectPlanned(
        plan(
          {
            kind: 'ISSUE',
            itemId: DRILL.id,
            fromLocationId: AISLE_A.id,
            quantity: 1,
            serialUnitIds: [fromFresh.id],
          },
          batchedSerialCtx(),
        ),
      )

      expect(movement.batchId).toBe(FRESH_BATCH.id)
    })

    it('records no batch when the units span several', () => {
      // A movement carries one batch id, so a mixed selection has none. The
      // service splits these into one movement per batch.
      const movement = expectPlanned(
        plan(
          {
            kind: 'ISSUE',
            itemId: DRILL.id,
            fromLocationId: AISLE_A.id,
            quantity: 2,
            serialUnitIds: [fromFresh.id, fromSoon.id],
          },
          batchedSerialCtx(),
        ),
      )

      expect(movement.batchId).toBeNull()
    })

    it('blocks a unit whose batch has expired', () => {
      expectRejected(
        plan(
          {
            kind: 'ISSUE',
            itemId: DRILL.id,
            fromLocationId: AISLE_A.id,
            quantity: 1,
            serialUnitIds: [fromExpired.id],
          },
          batchedSerialCtx(),
        ),
        MovementErrorCode.BATCH_EXPIRED,
      )
    })

    it('blocks a unit whose batch is quarantined', () => {
      expectRejected(
        plan(
          {
            kind: 'ISSUE',
            itemId: DRILL.id,
            fromLocationId: AISLE_A.id,
            quantity: 1,
            serialUnitIds: [fromQuarantine.id],
          },
          batchedSerialCtx(),
        ),
        MovementErrorCode.BATCH_BLOCKED,
      )
    })
  })
})

describe('error messages', () => {
  it('says there is none rather than "only 0 available"', () => {
    const decision = plan({
      kind: 'ISSUE',
      itemId: TAPE.id,
      fromLocationId: AISLE_A.id,
      quantity: 1,
    })

    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.error.message).toBe('There is none at that location.')
      expect(decision.error.details?.available).toBe(0)
    }
  })

  it('names the batch and date when refusing expired stock', () => {
    const decision = plan(
      {
        kind: 'ISSUE',
        itemId: ADHESIVE.id,
        fromLocationId: AISLE_A.id,
        quantity: 1,
        batchId: EXPIRED_BATCH.id,
      },
      context({
        item: ADHESIVE,
        batches: [EXPIRED_BATCH],
        ledger: [receipt(10, AISLE_A, ADHESIVE, EXPIRED_BATCH.id)],
      }),
    )

    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.error.message).toContain(EXPIRED_BATCH.batchNo)
      expect(decision.error.message).toContain('2026-09-16')
    }
  })
})

describe('expiry arithmetic', () => {
  it('treats expiry as a whole day, not an instant', () => {
    // A batch dated the 17th is good all day on the 17th, whatever the clock says.
    const batch = { ...FRESH_BATCH, expiryDate: new Date('2026-09-17T00:00:00.000Z') }

    expect(isExpired(batch, new Date('2026-09-17T23:59:59.000Z'))).toBe(false)
    expect(isExpired(batch, new Date('2026-09-18T00:00:00.000Z'))).toBe(true)
  })

  it('never expires a batch with no expiry date', () => {
    expect(isExpired({ ...FRESH_BATCH, expiryDate: null }, NOW)).toBe(false)
  })

  it('flags near expiry inside the window but not once expired', () => {
    expect(isNearExpiry(SOON_BATCH, NOW, 30)).toBe(true)
    expect(isNearExpiry(FRESH_BATCH, NOW, 30)).toBe(false)
    expect(isNearExpiry(EXPIRED_BATCH, NOW, 30)).toBe(false)
  })
})

describe('proposeBatchFefo', () => {
  const candidates = [
    { batch: FRESH_BATCH, available: 10 },
    { batch: SOON_BATCH, available: 10 },
  ]

  it('prefers the batch closest to expiry', () => {
    expect(proposeBatchFefo(candidates, 1, NOW)?.id).toBe(SOON_BATCH.id)
  })

  it('skips a batch without enough stock', () => {
    expect(
      proposeBatchFefo(
        [
          { batch: FRESH_BATCH, available: 10 },
          { batch: SOON_BATCH, available: 2 },
        ],
        5,
        NOW,
      )?.id,
    ).toBe(FRESH_BATCH.id)
  })

  it('never proposes an expired, quarantined or blocked batch', () => {
    expect(
      proposeBatchFefo(
        [
          { batch: EXPIRED_BATCH, available: 100 },
          { batch: QUARANTINED_BATCH, available: 100 },
        ],
        1,
        NOW,
      ),
    ).toBeNull()
  })

  it('puts undated batches last, since a known expiry should go first', () => {
    const undated = { ...FRESH_BATCH, id: 'batch-undated', expiryDate: null }

    expect(
      proposeBatchFefo(
        [
          { batch: undated, available: 10 },
          { batch: SOON_BATCH, available: 10 },
        ],
        1,
        NOW,
      )?.id,
    ).toBe(SOON_BATCH.id)
  })

  it('breaks an expiry tie deterministically, so two callers agree', () => {
    const a = { ...SOON_BATCH, id: 'b-a', batchNo: 'LOT-A' }
    const b = { ...SOON_BATCH, id: 'b-b', batchNo: 'LOT-B' }

    const forwards = proposeBatchFefo(
      [
        { batch: a, available: 5 },
        { batch: b, available: 5 },
      ],
      1,
      NOW,
    )
    const backwards = proposeBatchFefo(
      [
        { batch: b, available: 5 },
        { batch: a, available: 5 },
      ],
      1,
      NOW,
    )

    expect(forwards?.id).toBe(backwards?.id)
  })

  it('returns null when nothing can satisfy the quantity', () => {
    expect(proposeBatchFefo(candidates, 999, NOW)).toBeNull()
    expect(proposeBatchFefo([], 1, NOW)).toBeNull()
  })
})

describe('COUNT postings', () => {
  // A count correction must be distinguishable from a manual adjustment in the
  // ledger. They carry very different weight in a stock-accuracy report, and
  // only one of them is evidence. This was recorded as ADJUST until a browser
  // run showed /movements?type=count returning nothing after an approval.
  it('records MovementType.COUNT, not ADJUST', () => {
    const movement = expectPlanned(
      plan(
        { kind: 'COUNT', itemId: TAPE.id, locationId: AISLE_A.id, countedQuantity: 8 },
        context({ ledger: [receipt(10)] }),
      ),
    )

    expect(movement.type).toBe(MovementType.COUNT)
  })

  it('derives the difference from the counted total, like an adjustment', () => {
    const short = expectPlanned(
      plan(
        { kind: 'COUNT', itemId: TAPE.id, locationId: AISLE_A.id, countedQuantity: 8 },
        context({ ledger: [receipt(10)] }),
      ),
    )
    expect(short.quantity).toBe(2)
    expect(short.fromLocationId).toBe(AISLE_A.id)

    const over = expectPlanned(
      plan(
        { kind: 'COUNT', itemId: TAPE.id, locationId: AISLE_A.id, countedQuantity: 13 },
        context({ ledger: [receipt(10)] }),
      ),
    )
    expect(over.quantity).toBe(3)
    expect(over.toLocationId).toBe(AISLE_A.id)
  })

  it('needs no reason code — the count session is the justification', () => {
    const movement = expectPlanned(
      plan(
        { kind: 'COUNT', itemId: TAPE.id, locationId: AISLE_A.id, countedQuantity: 8 },
        context({ ledger: [receipt(10)] }),
      ),
    )

    expect(movement.reasonCodeId).toBeNull()
  })

  it('posts nothing when the shelf already matches', () => {
    // Stock can move between submitting a count and approving it. Recomputing
    // against current stock is the point; a no-op line is simply skipped.
    expectRejected(
      plan(
        { kind: 'COUNT', itemId: TAPE.id, locationId: AISLE_A.id, countedQuantity: 10 },
        context({ ledger: [receipt(10)] }),
      ),
      MovementErrorCode.NO_CHANGE,
    )
  })

  it('counts at the batch grain', () => {
    const movement = expectPlanned(
      plan(
        {
          kind: 'COUNT',
          itemId: ADHESIVE.id,
          locationId: AISLE_A.id,
          batchId: FRESH_BATCH.id,
          countedQuantity: 7,
        },
        context({
          item: ADHESIVE,
          batches: [FRESH_BATCH, SOON_BATCH],
          ledger: [
            receipt(10, AISLE_A, ADHESIVE, FRESH_BATCH.id),
            receipt(5, AISLE_A, ADHESIVE, SOON_BATCH.id),
          ],
        }),
      ),
    )

    // Only the counted batch moves; the other is untouched.
    expect(movement.quantity).toBe(3)
    expect(movement.batchId).toBe(FRESH_BATCH.id)
  })
})
