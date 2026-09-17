import { describe, expect, it } from 'vitest'
import {
  differenceOf,
  expectedAt,
  planCountPostings,
  reconcileCount,
  summariseCount,
  withinAutoApproveThreshold,
  countKey,
} from './count'
import { MovementType } from './types'
import { ADHESIVE, AISLE_A, FRESH_BATCH, GLOVES, SOON_BATCH, TAPE, receipt } from './fixtures'

/**
 * Ported from the mobile app's SubmitCycleCountTest.kt.
 *
 * The behavioural difference from the phone is deliberate: submitting a count no
 * longer posts anything. Reconciliation produces lines, a supervisor approves,
 * and only then does `planCountPostings` produce COUNT movements (WADR-008).
 */

describe('reconcileCount', () => {
  // SubmitCycleCountTest.itemsExpectedButNotSeenCountAsZero
  it('counts items expected but not seen as zero', () => {
    const lines = reconcileCount(new Map([[countKey('a', null), 3]]), [])

    expect(lines).toEqual([{ itemId: 'a', batchId: null, expected: 3, counted: 0 }])
    expect(differenceOf(lines[0]!)).toBe(-3)
  })

  it('counts items seen but not expected as a positive variance', () => {
    // A stray that belongs somewhere else. Both directions are variances.
    const lines = reconcileCount(new Map(), [{ itemId: 'a', batchId: null, quantity: 2 }])

    expect(lines).toEqual([{ itemId: 'a', batchId: null, expected: 0, counted: 2 }])
    expect(differenceOf(lines[0]!)).toBe(2)
  })

  it('reconciles per batch, not per item', () => {
    // The right total in the wrong batch is still a variance — which is the
    // whole reason counts reconcile at the tracking grain (WADR-018).
    const expected = expectedAt([receipt(10, AISLE_A, ADHESIVE, FRESH_BATCH.id)], AISLE_A.id)

    const lines = reconcileCount(expected, [
      { itemId: ADHESIVE.id, batchId: SOON_BATCH.id, quantity: 10 },
    ])

    expect(lines).toHaveLength(2)
    expect(lines.find((l) => l.batchId === FRESH_BATCH.id)).toMatchObject({
      expected: 10,
      counted: 0,
    })
    expect(lines.find((l) => l.batchId === SOON_BATCH.id)).toMatchObject({
      expected: 0,
      counted: 10,
    })
  })

  it('adds up repeated scans of the same item and batch', () => {
    // An operator scanning the same shelf twice is normal; the lines must merge.
    const lines = reconcileCount(new Map(), [
      { itemId: 'a', batchId: null, quantity: 2 },
      { itemId: 'a', batchId: null, quantity: 3 },
    ])

    expect(lines).toEqual([{ itemId: 'a', batchId: null, expected: 0, counted: 5 }])
  })

  it('is stable in order, so the review screen does not reshuffle', () => {
    const counted = [
      { itemId: 'z-item', batchId: null, quantity: 1 },
      { itemId: 'a-item', batchId: null, quantity: 1 },
    ]

    expect(reconcileCount(new Map(), counted).map((l) => l.itemId)).toEqual(['a-item', 'z-item'])
  })
})

describe('expectedAt', () => {
  it('reads expected quantities from the ledger at one location', () => {
    const ledger = [receipt(10, AISLE_A, TAPE), receipt(4, AISLE_A, GLOVES)]

    const lines = reconcileCount(expectedAt(ledger, AISLE_A.id), [])

    expect(lines).toHaveLength(2)
    expect(lines.every((line) => line.counted === 0)).toBe(true)
  })
})

describe('summariseCount', () => {
  it('splits lines into matched, short and over', () => {
    const summary = summariseCount([
      { itemId: 'a', batchId: null, expected: 10, counted: 10 },
      { itemId: 'b', batchId: null, expected: 10, counted: 8 },
      { itemId: 'c', batchId: null, expected: 0, counted: 3 },
    ])

    expect(summary).toMatchObject({ matched: 1, short: 1, over: 1, netUnits: 1 })
  })

  it('reports zero net when losses and gains cancel', () => {
    // Net zero is not the same as accurate — two lines are still wrong, and the
    // review screen has to show that rather than declaring the count clean.
    const summary = summariseCount([
      { itemId: 'a', batchId: null, expected: 10, counted: 8 },
      { itemId: 'b', batchId: null, expected: 0, counted: 2 },
    ])

    expect(summary.netUnits).toBe(0)
    expect(summary.short + summary.over).toBe(2)
  })

  it('separates lines never counted from lines counted short', () => {
    // A count is blind over the whole location, so an uncounted line is a
    // proposed write-off. Lumping it in with "found 8 of 10" hides that from
    // the supervisor who has to approve it.
    const summary = summariseCount([
      { itemId: 'a', batchId: null, expected: 10, counted: 8 },
      { itemId: 'b', batchId: null, expected: 10, counted: 0 },
      { itemId: 'c', batchId: null, expected: 7, counted: 0 },
    ])

    expect(summary.short).toBe(3)
    expect(summary.missing).toBe(2)
  })

  it('does not count an over-line as missing', () => {
    // expected 0, counted 0 cannot occur; expected 0 with stock found is a
    // stray, which is the opposite of missing.
    const summary = summariseCount([{ itemId: 'a', batchId: null, expected: 0, counted: 4 }])

    expect(summary.missing).toBe(0)
  })
})

describe('planCountPostings', () => {
  // SubmitCycleCountTest.postsOneCountMovementPerDifference
  it('posts one COUNT movement per difference', () => {
    const postings = planCountPostings(
      [
        { itemId: TAPE.id, batchId: null, expected: 10, counted: 8 },
        { itemId: GLOVES.id, batchId: null, expected: 0, counted: 1 },
      ],
      AISLE_A.id,
    )

    expect(postings).toHaveLength(2)
    expect(postings.every((posting) => posting.type === MovementType.COUNT)).toBe(true)

    const short = postings.find((posting) => posting.itemId === TAPE.id)!
    expect(short.quantity).toBe(2)
    expect(short.fromLocationId).toBe(AISLE_A.id)
    expect(short.toLocationId).toBeNull()

    const over = postings.find((posting) => posting.itemId === GLOVES.id)!
    expect(over.quantity).toBe(1)
    expect(over.toLocationId).toBe(AISLE_A.id)
    expect(over.fromLocationId).toBeNull()
  })

  // SubmitCycleCountTest.aMatchingCountPostsNothing
  it('posts nothing when the count matches', () => {
    expect(
      planCountPostings(
        [{ itemId: TAPE.id, batchId: null, expected: 10, counted: 10 }],
        AISLE_A.id,
      ),
    ).toEqual([])
  })

  it('carries the batch onto the posting', () => {
    const [posting] = planCountPostings(
      [{ itemId: ADHESIVE.id, batchId: FRESH_BATCH.id, expected: 10, counted: 7 }],
      AISLE_A.id,
    )

    expect(posting?.batchId).toBe(FRESH_BATCH.id)
    expect(posting?.quantity).toBe(3)
  })
})

describe('withinAutoApproveThreshold', () => {
  const summary = summariseCount([{ itemId: 'a', batchId: null, expected: 10, counted: 8 }])

  it('is off by default, so nothing posts without a supervisor', () => {
    expect(withinAutoApproveThreshold(summary, null)).toBe(false)
  })

  it('approves a variance inside the threshold and refuses one outside it', () => {
    expect(withinAutoApproveThreshold(summary, 2)).toBe(true)
    expect(withinAutoApproveThreshold(summary, 1)).toBe(false)
  })

  it('measures the magnitude, so an overage is judged the same as a shortage', () => {
    const over = summariseCount([{ itemId: 'a', batchId: null, expected: 0, counted: 5 }])
    expect(withinAutoApproveThreshold(over, 4)).toBe(false)
    expect(withinAutoApproveThreshold(over, 5)).toBe(true)
  })
})
