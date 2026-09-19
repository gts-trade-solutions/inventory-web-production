import 'server-only'
import type { LocationZone, PrismaClient, TrackingMode } from '@prisma/client'
import {
  physicalTotals,
  unitVolumeCm3,
  volumeFill,
  wouldFit,
  type Dimensions,
  type FitVerdict,
} from '@/lib/domain/cube'

/**
 * Where a receipt should go.
 *
 * ADVISORY. This produces a suggestion the receive form shows, with the reason
 * it was chosen, and the operator accepts or ignores it. Nothing here refuses a
 * movement: the operator is standing in front of the shelf and the system is
 * not, and a system that argues with the building loses that argument and then
 * loses its users.
 *
 * The ranking is deliberately boring, because a clever suggestion nobody can
 * predict is one nobody trusts:
 *
 *   1. Somewhere this item already is, with room. Keeping a SKU together makes
 *      picking shorter and counting honest; splitting it across six bays is how
 *      a count comes out wrong.
 *   2. Otherwise, the first matching rule's target, with room.
 *   3. Otherwise, nothing — and it says why rather than inventing an answer.
 *
 * "With room" uses whatever is known: cube against physical capacity when the
 * item is measured, unit capacity otherwise, and no constraint at all where
 * neither is set. A location with no capacity recorded is not "full", it is
 * unmeasured, and unmeasured must not be treated as an obstacle.
 */

export interface PutawaySuggestion {
  locationId: string
  code: string
  name: string
  /** Why this one, in a sentence an operator can read. */
  reason: string
  /** What it would be after, when that can be known. */
  fillAfterPercent: number | null
  fit: FitVerdict['kind']
}

export interface PutawayAdvice {
  suggestion: PutawaySuggestion | null
  /** When there is no suggestion, why not. Never silence. */
  because: string | null
  /** Places the rules pointed at that are already tight. Shown as context. */
  tight: Array<{ code: string; reason: string }>
}

interface Candidate {
  id: string
  code: string
  name: string
  zone: LocationZone
  capacityUnits: number | null
  capacityVolumeCm3: number | null
  capacityWeightGrams: number | null
}

export async function suggestPutaway(
  db: PrismaClient,
  input: { itemId: string; siteId: string; quantity: number },
): Promise<PutawayAdvice> {
  const item = await db.item.findFirst({
    where: { id: input.itemId, deletedAt: null },
    select: {
      id: true,
      categoryId: true,
      trackingMode: true,
      weightGrams: true,
      lengthMm: true,
      widthMm: true,
      heightMm: true,
    },
  })
  if (!item) return { suggestion: null, because: 'That item does not exist.', tight: [] }

  // Leaves only. A grouping is not somewhere a pallet goes, and recordMovement
  // would refuse it anyway.
  const candidates: Candidate[] = await db.location.findMany({
    where: {
      siteId: input.siteId,
      active: true,
      deletedAt: null,
      children: { none: { deletedAt: null } },
    },
    select: {
      id: true,
      code: true,
      name: true,
      zone: true,
      capacityUnits: true,
      capacityVolumeCm3: true,
      capacityWeightGrams: true,
    },
    orderBy: { code: 'asc' },
  })

  if (candidates.length === 0) {
    return { suggestion: null, because: 'This site has no locations to put stock in.', tight: [] }
  }

  const dimensions: Dimensions = {
    weightGrams: item.weightGrams,
    lengthMm: item.lengthMm,
    widthMm: item.widthMm,
    heightMm: item.heightMm,
  }

  const contents = await loadContents(
    db,
    candidates.map((candidate) => candidate.id),
  )

  const room = (candidate: Candidate) =>
    assessRoom(candidate, contents.get(candidate.id) ?? [], dimensions, input.quantity)

  const tight: Array<{ code: string; reason: string }> = []

  const consider = (candidate: Candidate, reason: string): PutawaySuggestion | null => {
    const verdict = room(candidate)

    if (verdict.fit === 'TIGHT') {
      tight.push({ code: candidate.code, reason: verdict.why })
      return null
    }

    return {
      locationId: candidate.id,
      code: candidate.code,
      name: candidate.name,
      reason,
      fillAfterPercent: verdict.fillAfterPercent,
      fit: verdict.fit,
    }
  }

  // --- 1. Where this item already lives ------------------------------------
  const existing = await db.stockLevel.groupBy({
    by: ['locationId'],
    where: { itemId: item.id, quantity: { gt: 0 } },
    _sum: { quantity: true },
  })

  // Fullest first among those: consolidating into the bay that already holds
  // most of it beats scattering across several.
  const homes = existing
    .sort((a, b) => (b._sum.quantity ?? 0) - (a._sum.quantity ?? 0))
    .map((row) => candidates.find((candidate) => candidate.id === row.locationId))
    .filter((candidate): candidate is Candidate => candidate !== undefined)

  for (const home of homes) {
    const found = consider(home, 'This item is already stored here')
    if (found) return { suggestion: found, because: null, tight }
  }

  // --- 2. What the rules say ------------------------------------------------
  const rules = await db.putawayRule.findMany({
    where: {
      siteId: input.siteId,
      active: true,
      OR: [{ categoryId: null }, { categoryId: item.categoryId }],
      AND: [{ OR: [{ trackingMode: null }, { trackingMode: item.trackingMode }] }],
    },
    orderBy: [{ priority: 'asc' }],
    select: {
      id: true,
      note: true,
      priority: true,
      categoryId: true,
      trackingMode: true,
      targetLocationId: true,
      targetZone: true,
      category: { select: { name: true } },
    },
  })

  /**
   * Priority FIRST, then narrowness.
   *
   * Sorting by narrowness alone discards priority entirely, which made a
   * specific rule at priority 50 beat a deliberate one at priority 1. Priority
   * is the field somebody sets when they want a particular answer, so it has to
   * win; narrowness only settles a tie.
   */
  const ordered = [...rules].sort(
    (a, b) => a.priority - b.priority || specificity(b) - specificity(a),
  )

  for (const rule of ordered) {
    const targets = rule.targetLocationId
      ? candidates.filter((candidate) => candidate.id === rule.targetLocationId)
      : rule.targetZone
        ? candidates.filter((candidate) => candidate.zone === rule.targetZone)
        : []

    if (targets.length === 0) continue

    const reason =
      rule.note ?? describeRule(rule.category?.name ?? null, rule.trackingMode, rule.targetZone)

    // Emptiest first within a rule's targets, so stock spreads rather than
    // filling one bay and then failing.
    const byRoom = targets
      .map((candidate) => ({ candidate, assessed: room(candidate) }))
      .sort((a, b) => (a.assessed.fillAfterPercent ?? 0) - (b.assessed.fillAfterPercent ?? 0))

    for (const { candidate } of byRoom) {
      const found = consider(candidate, reason)
      if (found) return { suggestion: found, because: null, tight }
    }
  }

  // --- 3. Nothing to say ----------------------------------------------------
  return {
    suggestion: null,
    because:
      rules.length === 0
        ? 'No putaway rule covers this item, and it is not already stored anywhere.'
        : 'Every location the rules point at is already tight.',
    tight,
  }
}

// ---------------------------------------------------------------------------

/** How narrow a rule is. More conditions means it was written more deliberately. */
function specificity(rule: { categoryId: string | null; trackingMode: TrackingMode | null }) {
  return (rule.categoryId ? 1 : 0) + (rule.trackingMode ? 1 : 0)
}

function describeRule(
  categoryName: string | null,
  trackingMode: TrackingMode | null,
  zone: LocationZone | null,
): string {
  const what = [categoryName, trackingMode ? `${trackingMode.toLowerCase()}-tracked` : null]
    .filter(Boolean)
    .join(' ')

  return what
    ? `Rule: ${what} goes to ${zone ? zone.toLowerCase() : 'this location'}`
    : `Rule: everything goes to ${zone ? zone.toLowerCase() : 'this location'}`
}

async function loadContents(db: PrismaClient, locationIds: string[]) {
  const levels = await db.stockLevel.findMany({
    where: { locationId: { in: locationIds }, quantity: { gt: 0 } },
    select: {
      locationId: true,
      quantity: true,
      item: {
        select: { weightGrams: true, lengthMm: true, widthMm: true, heightMm: true },
      },
    },
  })

  const byLocation = new Map<string, Array<{ quantity: number; dimensions: Dimensions }>>()
  for (const level of levels) {
    const lines = byLocation.get(level.locationId) ?? []
    lines.push({ quantity: level.quantity, dimensions: level.item })
    byLocation.set(level.locationId, lines)
  }

  return byLocation
}

/**
 * Whether a candidate has room, using whatever is known.
 *
 * An unmeasured location is NOT full. Treating "nobody recorded a capacity" as
 * an obstacle would rule out every location in a warehouse that has not been
 * measured, which is most of them, and the feature would suggest nothing for
 * ever.
 */
function assessRoom(
  candidate: Candidate,
  contents: Array<{ quantity: number; dimensions: Dimensions }>,
  incoming: Dimensions,
  quantity: number,
): { fit: FitVerdict['kind']; why: string; fillAfterPercent: number | null } {
  const present = physicalTotals(contents)

  // Physical first, where both sides are known — it is the better answer.
  if (candidate.capacityVolumeCm3 !== null || candidate.capacityWeightGrams !== null) {
    const verdict = wouldFit({
      present,
      capacityVolumeCm3: candidate.capacityVolumeCm3,
      capacityWeightGrams: candidate.capacityWeightGrams,
      incoming: { quantity, dimensions: incoming },
    })

    if (verdict.kind === 'TIGHT') {
      return {
        fit: 'TIGHT',
        why: verdict.reasons.join(' and '),
        fillAfterPercent: verdict.volumeAfterPercent,
      }
    }
    if (verdict.kind === 'FITS') {
      return { fit: 'FITS', why: '', fillAfterPercent: verdict.volumeAfterPercent }
    }
    // UNKNOWN falls through to the unit check below, which may still know.
  }

  if (candidate.capacityUnits !== null) {
    const after = present.totalQuantity + quantity
    const percent = Math.round((after / candidate.capacityUnits) * 100)

    return after > candidate.capacityUnits
      ? { fit: 'TIGHT', why: `it would be ${percent}% full`, fillAfterPercent: percent }
      : { fit: 'FITS', why: '', fillAfterPercent: percent }
  }

  // Nothing known. Not an obstacle — just no figure to show.
  const fill = volumeFill(present, candidate.capacityVolumeCm3)
  return { fit: 'UNKNOWN', why: '', fillAfterPercent: fill.percent }
}

export { unitVolumeCm3 }
