/**
 * GS1 GTIN-13 (EAN-13) helpers.
 *
 * Ported from the mobile app's `core/domain/model/Gtin.kt`. Both clients must
 * agree on what a valid barcode is, or a scan that works on the phone fails on
 * the web (ARCHITECTURE §1.2).
 */

export class GtinError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GtinError'
  }
}

const TWELVE_DIGITS = /^\d{12}$/
const THIRTEEN_DIGITS = /^\d{13}$/

/**
 * Mod-10 check digit for the first 12 digits of a GTIN-13.
 *
 * Digits alternate weight 1 and 3 starting from the left, and the check digit is
 * whatever brings the total to a multiple of ten.
 */
export function checkDigit(first12: string): number {
  if (!TWELVE_DIGITS.test(first12)) {
    throw new GtinError(`Expected 12 digits, got "${first12}"`)
  }

  let sum = 0
  for (let index = 0; index < 12; index++) {
    sum += Number(first12[index]) * (index % 2 === 0 ? 1 : 3)
  }

  return (10 - (sum % 10)) % 10
}

/** Completes a 12-digit body into a full GTIN-13. */
export function ean13(first12: string): string {
  return first12 + String(checkDigit(first12))
}

export function isValidEan13(code: string): boolean {
  return THIRTEEN_DIGITS.test(code) && checkDigit(code.slice(0, 12)) === Number(code[12])
}

/**
 * Normalises a scanned barcode for lookup.
 *
 * Scanners and label printers disagree about leading zeros: the same trade item
 * can arrive as a 12-digit UPC-A, a 13-digit EAN-13 or a 14-digit GTIN-14 with a
 * leading indicator zero. Comparing the raw string means the same physical item
 * misses on one scanner and hits on another.
 */
export function normaliseBarcode(raw: string): string {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) return trimmed

  // A GTIN-14 whose indicator digit is 0 is the same trade item as its EAN-13.
  if (trimmed.length === 14 && trimmed.startsWith('0')) {
    return trimmed.slice(1)
  }

  // UPC-A is an EAN-13 with an implied leading zero.
  if (trimmed.length === 12) {
    const candidate = `0${trimmed}`
    if (isValidEan13(candidate)) return candidate
  }

  return trimmed
}
