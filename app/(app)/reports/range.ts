/**
 * The date range shared by the period reports.
 *
 * Not a Server Action file, and not marked `'use server'`: it is plain helpers
 * imported by pages. A `"use server"` file may only export async functions, and
 * putting these there would compile, typecheck and lint cleanly before failing
 * at runtime.
 */

const DAY_MS = 86_400_000

/** yyyy-mm-dd, which is what a date input reads and writes. */
export function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}

/**
 * The requested range, defaulting to the last 30 days.
 *
 * A report that opens empty because no dates were chosen teaches people that it
 * is broken. A sensible default that the filters then show is the version
 * somebody can actually correct.
 */
export function defaultRange(
  params: { from?: string; to?: string },
  now: Date = new Date(),
): { from: string; to: string } {
  const to = valid(params.to) ?? isoDate(now)
  const from = valid(params.from) ?? isoDate(new Date(now.getTime() - 30 * DAY_MS))

  // Swapped rather than rejected. Somebody who types the dates the wrong way
  // round means the range between them, and an error message here would be
  // pedantry.
  return from <= to ? { from, to } : { from: to, to: from }
}

function valid(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  return Number.isNaN(new Date(value).getTime()) ? null : value
}

/**
 * The `to` date, inclusive.
 *
 * A date input gives midnight, so a range ending on the 18th would otherwise
 * exclude everything that happened on the 18th — a report that silently drops
 * its own last day, which is the day people most often care about.
 */
export function endOfDay(value: string): Date {
  const end = new Date(value)
  end.setHours(23, 59, 59, 999)
  return end
}
