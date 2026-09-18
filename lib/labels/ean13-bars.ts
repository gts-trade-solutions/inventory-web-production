import { checkDigit, isValidEan13 } from '@/lib/domain/gtin'

/**
 * EAN-13 bar patterns.
 *
 * Ported from the mobile app's `Ean13.kt`, which draws the same barcode on the
 * label preview there. Both previews have to agree with each other and with
 * what the printer produces, or "what you see is what prints" is a slogan
 * rather than a property.
 *
 * The encoding is fixed by the standard: the first digit is not encoded as
 * bars at all — it is carried by which parity pattern (A or B) each of the next
 * six digits uses. Getting that table wrong produces a barcode that looks
 * perfectly convincing and scans as a different product.
 */

/** Left-hand odd parity. */
const L = [
  '0001101', '0011001', '0010011', '0111101', '0100011',
  '0110001', '0101111', '0111011', '0110111', '0001011',
]

/** Left-hand even parity. */
const G = [
  '0100111', '0110011', '0011011', '0100001', '0011101',
  '0111001', '0000101', '0010001', '0001001', '0010111',
]

/** Right-hand, always even parity. */
const R = [
  '1110010', '1100110', '1101100', '1000010', '1011100',
  '1001110', '1010000', '1000100', '1001000', '1110100',
]

/** Which of the first six digits use even parity, chosen by the first digit. */
const PARITY = [
  'LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG',
  'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL',
]

const GUARD = '101'
const CENTRE = '01010'

export class Ean13Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Ean13Error'
  }
}

/**
 * The bar pattern for a GTIN-13, as a string of '1' (bar) and '0' (space).
 *
 * Accepts twelve digits and computes the check digit, matching `^BEN`, where
 * the printer does the same. Passing thirteen checks it instead — a barcode
 * with a wrong check digit is one no scanner will read, and finding that out
 * from a roll of printed labels is expensive.
 */
export function ean13Bars(digits: string): string {
  const code = normalise(digits)

  const first = Number(code[0])
  const parity = PARITY[first]!
  const left = code.slice(1, 7)
  const right = code.slice(7)

  let bars = GUARD
  for (let i = 0; i < 6; i++) {
    const digit = Number(left[i])
    bars += parity[i] === 'L' ? L[digit]! : G[digit]!
  }

  bars += CENTRE
  for (const character of right) bars += R[Number(character)]!
  bars += GUARD

  // 3 + 42 + 5 + 42 + 3. A pattern of any other length means a bug above, and
  // a malformed barcode is worse than none.
  if (bars.length !== 95) {
    throw new Ean13Error(`Produced ${bars.length} modules; an EAN-13 is always 95.`)
  }

  return bars
}

/** Twelve digits get a check digit; thirteen must already carry a right one. */
export function normalise(digits: string): string {
  const trimmed = digits.trim()

  if (/^\d{12}$/.test(trimmed)) return trimmed + checkDigit(trimmed)

  if (/^\d{13}$/.test(trimmed)) {
    if (!isValidEan13(trimmed)) {
      throw new Ean13Error(`${trimmed} has the wrong check digit, so no scanner would read it.`)
    }
    return trimmed
  }

  throw new Ean13Error(`An EAN-13 is 12 or 13 digits; got "${trimmed}".`)
}

/**
 * The human-readable digits, grouped the way they are printed: the first digit
 * to the left of the bars, then two groups of six.
 */
export function ean13Groups(digits: string): [string, string, string] {
  const code = normalise(digits)
  return [code.slice(0, 1), code.slice(1, 7), code.slice(7)]
}
