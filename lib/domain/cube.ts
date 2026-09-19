/**
 * Physical size: what one unit takes up, and how much of a place it fills.
 *
 * Pure, so the arithmetic can be tested without a database — and so the same
 * numbers are produced wherever they are needed.
 *
 * The governing rule here is that an unmeasured item produces UNKNOWN, never a
 * zero. A bay holding nine hundred measured boxes and one unmeasured pallet is
 * not "full to 40%", and reporting it that way is how somebody sends a delivery
 * to a bay that has no room. Every figure below carries how much of the stock
 * it could actually account for, so a caller cannot accidentally read a partial
 * answer as a complete one.
 */

export interface Dimensions {
  weightGrams: number | null
  lengthMm: number | null
  widthMm: number | null
  heightMm: number | null
}

/**
 * Volume of one unit in cm³, or null when any dimension is missing.
 *
 * Derived, never stored, so it cannot drift from the dimensions it came from.
 * A partial measurement is no measurement: two dimensions out of three describe
 * a rectangle, and stock is not flat.
 */
export function unitVolumeCm3(item: Dimensions): number | null {
  const { lengthMm, widthMm, heightMm } = item
  if (!lengthMm || !widthMm || !heightMm) return null

  // Millimetres cubed to centimetres cubed. Rounded, because a cubic
  // millimetre is far below the precision anybody measured to.
  return Math.round((lengthMm * widthMm * heightMm) / 1000)
}

export function isMeasured(item: Dimensions): boolean {
  return unitVolumeCm3(item) !== null
}

export interface StockedItem {
  quantity: number
  dimensions: Dimensions
}

/**
 * What a set of stock physically amounts to.
 *
 * `measuredQuantity` and `totalQuantity` are the honesty: the volume and weight
 * describe only the measured part, and the caller is told how big that part is.
 */
export interface PhysicalTotals {
  volumeCm3: number
  weightGrams: number
  /** Units the figures above account for. */
  measuredQuantity: number
  /** Units present in total, measured or not. */
  totalQuantity: number
  /** Distinct lines with no usable dimensions. */
  unmeasuredLines: number
}

export function physicalTotals(stock: readonly StockedItem[]): PhysicalTotals {
  let volumeCm3 = 0
  let weightGrams = 0
  let measuredQuantity = 0
  let totalQuantity = 0
  let unmeasuredLines = 0

  for (const line of stock) {
    totalQuantity += line.quantity

    const volume = unitVolumeCm3(line.dimensions)
    const weight = line.dimensions.weightGrams

    // Volume is what governs whether something fits, so a line without it is
    // unmeasured even if somebody weighed it.
    if (volume === null) {
      unmeasuredLines++
      continue
    }

    volumeCm3 += volume * line.quantity
    weightGrams += (weight ?? 0) * line.quantity
    measuredQuantity += line.quantity
  }

  return { volumeCm3, weightGrams, measuredQuantity, totalQuantity, unmeasuredLines }
}

export type Confidence =
  /** Every unit present is measured. The figure is the whole truth. */
  | 'COMPLETE'
  /** Some units have no dimensions, so the figure is an UNDERCOUNT. */
  | 'PARTIAL'
  /** Nothing is measured, or no capacity is set. There is no figure. */
  | 'UNKNOWN'

export interface Fill {
  percent: number | null
  confidence: Confidence
  measuredQuantity: number
  totalQuantity: number
}

/**
 * How full a place is by volume.
 *
 * Returns the confidence alongside the number, because a percentage computed
 * from half the stock is a different claim from one computed from all of it,
 * and a screen that shows them identically invites the wrong decision.
 */
export function volumeFill(totals: PhysicalTotals, capacityCm3: number | null): Fill {
  const base = {
    measuredQuantity: totals.measuredQuantity,
    totalQuantity: totals.totalQuantity,
  }

  if (!capacityCm3 || capacityCm3 <= 0) {
    return { percent: null, confidence: 'UNKNOWN', ...base }
  }

  // Nothing measured: there is no figure to give, even though a capacity
  // exists. Returning 0% here would read as "empty", and an empty bay and an
  // unmeasured one are opposite situations.
  if (totals.totalQuantity > 0 && totals.measuredQuantity === 0) {
    return { percent: null, confidence: 'UNKNOWN', ...base }
  }

  return {
    percent: Math.round((totals.volumeCm3 / capacityCm3) * 100),
    confidence: totals.unmeasuredLines > 0 ? 'PARTIAL' : 'COMPLETE',
    ...base,
  }
}

/** How heavily loaded a place is, on the same terms. */
export function weightFill(totals: PhysicalTotals, capacityGrams: number | null): Fill {
  const base = {
    measuredQuantity: totals.measuredQuantity,
    totalQuantity: totals.totalQuantity,
  }

  if (!capacityGrams || capacityGrams <= 0) {
    return { percent: null, confidence: 'UNKNOWN', ...base }
  }
  if (totals.totalQuantity > 0 && totals.measuredQuantity === 0) {
    return { percent: null, confidence: 'UNKNOWN', ...base }
  }

  return {
    percent: Math.round((totals.weightGrams / capacityGrams) * 100),
    confidence: totals.unmeasuredLines > 0 ? 'PARTIAL' : 'COMPLETE',
    ...base,
  }
}

export interface FitQuestion {
  /** What is already there. */
  present: PhysicalTotals
  capacityVolumeCm3: number | null
  capacityWeightGrams: number | null
  /** What somebody wants to put there. */
  incoming: { quantity: number; dimensions: Dimensions }
}

export type FitVerdict =
  /** It fits, on every limit that is known. */
  | { kind: 'FITS'; volumeAfterPercent: number | null; weightAfterPercent: number | null }
  /** It does not, on at least one known limit. Advisory — never a refusal. */
  | {
      kind: 'TIGHT'
      reasons: string[]
      volumeAfterPercent: number | null
      weightAfterPercent: number | null
    }
  /** Not enough is measured to say. */
  | { kind: 'UNKNOWN'; because: string }

/**
 * Whether a quantity would fit somewhere.
 *
 * Advisory in every case. Nothing here refuses a movement: if the goods are
 * physically on the shelf then the ledger has to be able to say so, and a
 * system that argues with the building loses.
 *
 * "Would it fit" is also a simplification — it compares raw cube against raw
 * capacity, and real packing never achieves 100%. That is why the answer is
 * TIGHT rather than "will not fit", and why it is shown to a person who can
 * see the shelf rather than used to decide anything on its own.
 */
export function wouldFit(question: FitQuestion): FitVerdict {
  const { present, incoming, capacityVolumeCm3, capacityWeightGrams } = question

  const incomingVolume = unitVolumeCm3(incoming.dimensions)
  if (incomingVolume === null) {
    return { kind: 'UNKNOWN', because: 'this item has no measured dimensions' }
  }
  if (capacityVolumeCm3 === null && capacityWeightGrams === null) {
    return { kind: 'UNKNOWN', because: 'this location has no physical capacity set' }
  }
  if (present.unmeasuredLines > 0) {
    return {
      kind: 'UNKNOWN',
      because: `${present.unmeasuredLines} line${present.unmeasuredLines === 1 ? '' : 's'} already there ${present.unmeasuredLines === 1 ? 'has' : 'have'} no dimensions, so what is left cannot be known`,
    }
  }

  const volumeAfter = present.volumeCm3 + incomingVolume * incoming.quantity
  const weightAfter =
    present.weightGrams + (incoming.dimensions.weightGrams ?? 0) * incoming.quantity

  const volumeAfterPercent = capacityVolumeCm3
    ? Math.round((volumeAfter / capacityVolumeCm3) * 100)
    : null
  const weightAfterPercent = capacityWeightGrams
    ? Math.round((weightAfter / capacityWeightGrams) * 100)
    : null

  const reasons: string[] = []
  if (capacityVolumeCm3 && volumeAfter > capacityVolumeCm3) {
    reasons.push(`it would be ${volumeAfterPercent}% full by volume`)
  }
  if (capacityWeightGrams && weightAfter > capacityWeightGrams) {
    reasons.push(`it would be ${weightAfterPercent}% of the weight limit`)
  }

  return reasons.length > 0
    ? { kind: 'TIGHT', reasons, volumeAfterPercent, weightAfterPercent }
    : { kind: 'FITS', volumeAfterPercent, weightAfterPercent }
}

/** Human-readable cm³, because 2400000 cm³ means nothing at a glance. */
export function describeVolume(cm3: number | null): string {
  if (cm3 === null) return '—'
  if (cm3 >= 1_000_000) return `${(cm3 / 1_000_000).toFixed(2)} m³`
  if (cm3 >= 1000) return `${(cm3 / 1000).toFixed(1)} L`
  return `${cm3} cm³`
}

/** Human-readable grams, for the same reason. */
export function describeWeight(grams: number | null): string {
  if (grams === null) return '—'
  if (grams >= 1_000_000) return `${(grams / 1_000_000).toFixed(2)} t`
  if (grams >= 1000) return `${(grams / 1000).toFixed(1)} kg`
  return `${grams} g`
}
