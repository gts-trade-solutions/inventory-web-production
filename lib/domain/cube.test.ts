import { describe, expect, it } from 'vitest'
import {
  describeVolume,
  describeWeight,
  isMeasured,
  physicalTotals,
  unitVolumeCm3,
  volumeFill,
  weightFill,
  wouldFit,
  type Dimensions,
} from './cube'

/**
 * Physical size.
 *
 * One rule governs all of this: an unmeasured item produces UNKNOWN, never a
 * zero. A bay holding nine hundred measured boxes and one unmeasured pallet is
 * not "40% full", and reporting it that way is how a delivery gets sent to a
 * bay with no room in it. Most of these tests exist to pin that down.
 */

const box: Dimensions = { weightGrams: 500, lengthMm: 300, widthMm: 200, heightMm: 150 }
const unmeasured: Dimensions = {
  weightGrams: null,
  lengthMm: null,
  widthMm: null,
  heightMm: null,
}

describe('unitVolumeCm3', () => {
  it('multiplies the three dimensions and converts to cm³', () => {
    // 300 × 200 × 150 mm = 9,000,000 mm³ = 9,000 cm³
    expect(unitVolumeCm3(box)).toBe(9000)
  })

  it('is null when any single dimension is missing', () => {
    // Two out of three describe a rectangle, and stock is not flat. A partial
    // measurement is no measurement.
    expect(unitVolumeCm3({ ...box, heightMm: null })).toBeNull()
    expect(unitVolumeCm3({ ...box, widthMm: null })).toBeNull()
    expect(unitVolumeCm3({ ...box, lengthMm: null })).toBeNull()
  })

  it('is null for a zero dimension, which is not a measurement either', () => {
    expect(unitVolumeCm3({ ...box, heightMm: 0 })).toBeNull()
  })

  it('does not need a weight', () => {
    // Volume is what decides whether something fits. Weight is a separate limit.
    expect(unitVolumeCm3({ ...box, weightGrams: null })).toBe(9000)
  })

  it('reports whether an item is measured at all', () => {
    expect(isMeasured(box)).toBe(true)
    expect(isMeasured(unmeasured)).toBe(false)
  })
})

describe('physicalTotals', () => {
  it('sums volume and weight across quantities', () => {
    const totals = physicalTotals([{ quantity: 10, dimensions: box }])

    expect(totals.volumeCm3).toBe(90_000)
    expect(totals.weightGrams).toBe(5000)
    expect(totals.measuredQuantity).toBe(10)
    expect(totals.totalQuantity).toBe(10)
    expect(totals.unmeasuredLines).toBe(0)
  })

  it('counts unmeasured stock in the total but NOT in the figures', () => {
    // The figure is an undercount, and the caller has to be able to tell.
    const totals = physicalTotals([
      { quantity: 10, dimensions: box },
      { quantity: 90, dimensions: unmeasured },
    ])

    expect(totals.volumeCm3).toBe(90_000)
    expect(totals.measuredQuantity).toBe(10)
    expect(totals.totalQuantity).toBe(100)
    expect(totals.unmeasuredLines).toBe(1)
  })

  it('treats an item with a weight but no dimensions as unmeasured', () => {
    // Volume governs fit. Knowing only the weight does not say whether it goes
    // on the shelf.
    const totals = physicalTotals([
      { quantity: 5, dimensions: { ...unmeasured, weightGrams: 800 } },
    ])

    expect(totals.unmeasuredLines).toBe(1)
    expect(totals.weightGrams).toBe(0)
  })
})

describe('volumeFill', () => {
  const measured = physicalTotals([{ quantity: 10, dimensions: box }])

  it('reports a percentage when everything is measured', () => {
    const fill = volumeFill(measured, 180_000)

    expect(fill.percent).toBe(50)
    expect(fill.confidence).toBe('COMPLETE')
  })

  it('marks the figure PARTIAL when some stock is unmeasured', () => {
    const mixed = physicalTotals([
      { quantity: 10, dimensions: box },
      { quantity: 90, dimensions: unmeasured },
    ])

    const fill = volumeFill(mixed, 180_000)

    expect(fill.percent).toBe(50)
    // 50% of the capacity is accounted for by a tenth of the units. Saying
    // "50%" without saying that is the dangerous half of the answer.
    expect(fill.confidence).toBe('PARTIAL')
    expect(fill.measuredQuantity).toBe(10)
    expect(fill.totalQuantity).toBe(100)
  })

  it('gives NO figure when a full bay has nothing measured', () => {
    // 0% would read as empty, and an empty bay and an unmeasured one are
    // opposite situations.
    const nothing = physicalTotals([{ quantity: 500, dimensions: unmeasured }])

    const fill = volumeFill(nothing, 180_000)

    expect(fill.percent).toBeNull()
    expect(fill.confidence).toBe('UNKNOWN')
  })

  it('gives no figure when no capacity is set', () => {
    expect(volumeFill(measured, null).percent).toBeNull()
    expect(volumeFill(measured, null).confidence).toBe('UNKNOWN')
  })

  it('reports an empty measured bay as 0% rather than unknown', () => {
    const empty = physicalTotals([])

    expect(volumeFill(empty, 180_000).percent).toBe(0)
    expect(volumeFill(empty, 180_000).confidence).toBe('COMPLETE')
  })

  it('lets a percentage exceed 100, because it describes rather than forbids', () => {
    const overfull = physicalTotals([{ quantity: 30, dimensions: box }])

    expect(volumeFill(overfull, 180_000).percent).toBe(150)
  })
})

describe('weightFill', () => {
  it('works on the same terms as volume', () => {
    const totals = physicalTotals([{ quantity: 10, dimensions: box }])

    expect(weightFill(totals, 10_000).percent).toBe(50)
    expect(weightFill(totals, null).confidence).toBe('UNKNOWN')
  })
})

describe('wouldFit', () => {
  const empty = physicalTotals([])

  it('says it fits when there is room', () => {
    const verdict = wouldFit({
      present: empty,
      capacityVolumeCm3: 180_000,
      capacityWeightGrams: null,
      incoming: { quantity: 10, dimensions: box },
    })

    expect(verdict.kind).toBe('FITS')
    if (verdict.kind !== 'FITS') throw new Error('expected FITS')
    expect(verdict.volumeAfterPercent).toBe(50)
  })

  it('says TIGHT rather than "will not fit"', () => {
    // Raw cube against raw capacity: real packing never achieves 100%, so this
    // is advice to a person who can see the shelf, not a decision.
    const verdict = wouldFit({
      present: empty,
      capacityVolumeCm3: 180_000,
      capacityWeightGrams: null,
      incoming: { quantity: 30, dimensions: box },
    })

    expect(verdict.kind).toBe('TIGHT')
    if (verdict.kind !== 'TIGHT') throw new Error('expected TIGHT')
    expect(verdict.reasons[0]).toMatch(/150% full by volume/)
  })

  it('catches a weight limit even when the volume is fine', () => {
    // Lead and feathers. A bay with room can still be over its weight limit.
    const verdict = wouldFit({
      present: empty,
      capacityVolumeCm3: 10_000_000,
      capacityWeightGrams: 1000,
      incoming: { quantity: 10, dimensions: box },
    })

    expect(verdict.kind).toBe('TIGHT')
    if (verdict.kind !== 'TIGHT') throw new Error('expected TIGHT')
    expect(verdict.reasons.some((reason) => /weight limit/.test(reason))).toBe(true)
  })

  it('counts what is already there', () => {
    const present = physicalTotals([{ quantity: 15, dimensions: box }])

    const verdict = wouldFit({
      present,
      capacityVolumeCm3: 180_000,
      capacityWeightGrams: null,
      incoming: { quantity: 10, dimensions: box },
    })

    expect(verdict.kind).toBe('TIGHT')
  })

  it('refuses to guess when the INCOMING item is unmeasured', () => {
    const verdict = wouldFit({
      present: empty,
      capacityVolumeCm3: 180_000,
      capacityWeightGrams: null,
      incoming: { quantity: 10, dimensions: unmeasured },
    })

    expect(verdict.kind).toBe('UNKNOWN')
    if (verdict.kind !== 'UNKNOWN') throw new Error('expected UNKNOWN')
    expect(verdict.because).toMatch(/no measured dimensions/)
  })

  it('refuses to guess when what is ALREADY there is unmeasured', () => {
    // The dangerous case. The incoming pallet is measured, the capacity is
    // known, and the bay looks empty because nothing in it has a cube — so a
    // naive calculation says "plenty of room" about a bay that is full.
    const present = physicalTotals([{ quantity: 500, dimensions: unmeasured }])

    const verdict = wouldFit({
      present,
      capacityVolumeCm3: 180_000,
      capacityWeightGrams: null,
      incoming: { quantity: 1, dimensions: box },
    })

    expect(verdict.kind).toBe('UNKNOWN')
    if (verdict.kind !== 'UNKNOWN') throw new Error('expected UNKNOWN')
    expect(verdict.because).toMatch(/no dimensions/)
  })

  it('refuses to guess when the location has no physical capacity', () => {
    const verdict = wouldFit({
      present: empty,
      capacityVolumeCm3: null,
      capacityWeightGrams: null,
      incoming: { quantity: 10, dimensions: box },
    })

    expect(verdict.kind).toBe('UNKNOWN')
  })
})

describe('describing figures for people', () => {
  it('scales volume to litres and cubic metres', () => {
    expect(describeVolume(500)).toBe('500 cm³')
    expect(describeVolume(9000)).toBe('9.0 L')
    expect(describeVolume(2_400_000)).toBe('2.40 m³')
    expect(describeVolume(null)).toBe('—')
  })

  it('scales weight to kilograms and tonnes', () => {
    expect(describeWeight(500)).toBe('500 g')
    expect(describeWeight(5000)).toBe('5.0 kg')
    expect(describeWeight(2_400_000)).toBe('2.40 t')
    expect(describeWeight(null)).toBe('—')
  })
})
