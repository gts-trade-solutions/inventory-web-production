import { ean13, isValidEan13 } from './gtin'

/**
 * GS1 SGTIN-96 EPC encoding (Tag Data Standard): the identity a UHF RFID label
 * carries for a trade item.
 *
 * Ported from the mobile app's `core/domain/model/Sgtin96.kt`, and load-bearing
 * for traceability: `serial_units.epc` stores one of these, so decoding a tag
 * read resolves to exactly one physical unit. That is what makes an RFID cycle
 * count report "these two units are missing" rather than "we are two short"
 * (ARCHITECTURE §5.4, WADR-019).
 *
 * Supports partition 5 (7-digit company prefix), which covers this system's
 * GTINs. A production deployment with other prefix lengths needs the full
 * partition table — the same limitation the Kotlin version carries.
 */

export const FILTER_POS_ITEM = 1
/** 2^38 - 1: the widest serial the 38-bit field holds. */
export const MAX_SERIAL = 274_877_906_943

const HEADER = 0x30
const PARTITION = 5

const FIELD = {
  header: { at: 0, bits: 8 },
  filter: { at: 8, bits: 3 },
  partition: { at: 11, bits: 3 },
  companyPrefix: { at: 14, bits: 24 },
  itemReference: { at: 38, bits: 20 },
  serial: { at: 58, bits: 38 },
} as const

export interface DecodedSgtin96 {
  filter: number
  companyPrefix: string
  /** Indicator digit followed by the item reference. */
  itemReference: string
  serial: number
}

export class Sgtin96Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Sgtin96Error'
  }
}

/** The GTIN-13 for indicator digit 0, or null for other packaging levels. */
export function gtin13Of(decoded: DecodedSgtin96): string | null {
  if (decoded.itemReference[0] !== '0') return null
  return ean13(decoded.companyPrefix + decoded.itemReference.slice(1))
}

export function encode(
  companyPrefix: string,
  itemReference: string,
  serial: number,
  filter: number = FILTER_POS_ITEM,
): string {
  if (!/^\d{7}$/.test(companyPrefix)) {
    throw new Sgtin96Error(`Company prefix must be 7 digits, got "${companyPrefix}"`)
  }
  if (!/^\d{6}$/.test(itemReference)) {
    throw new Sgtin96Error(`Item reference must be 6 digits, got "${itemReference}"`)
  }
  if (!Number.isInteger(serial) || serial < 0 || serial > MAX_SERIAL) {
    throw new Sgtin96Error(`Serial out of range: ${serial}`)
  }
  if (!Number.isInteger(filter) || filter < 0 || filter > 7) {
    throw new Sgtin96Error(`Filter must be 0-7, got ${filter}`)
  }

  // Assembled as a bit string rather than with bitwise operators: JavaScript's
  // bitwise operators are 32-bit, and this value is 96 bits wide.
  const bits =
    toBits(HEADER, FIELD.header.bits) +
    toBits(filter, FIELD.filter.bits) +
    toBits(PARTITION, FIELD.partition.bits) +
    toBits(Number(companyPrefix), FIELD.companyPrefix.bits) +
    toBits(Number(itemReference), FIELD.itemReference.bits) +
    toBits(serial, FIELD.serial.bits)

  let hex = ''
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  }
  return hex.toUpperCase()
}

/** EPC for unit `serial` of the item with this GTIN-13 (indicator digit 0). */
export function fromGtin13(gtin13: string, serial: number): string {
  if (!isValidEan13(gtin13)) {
    throw new Sgtin96Error(`Not a valid GTIN-13: ${gtin13}`)
  }
  return encode(gtin13.slice(0, 7), `0${gtin13.slice(7, 12)}`, serial)
}

/** Decodes a 24-hex-digit EPC, or returns null if it isn't a partition-5 SGTIN-96. */
export function decode(epcHex: string): DecodedSgtin96 | null {
  if (epcHex.length !== 24) return null

  let bits = ''
  for (const char of epcHex) {
    const value = parseInt(char, 16)
    // parseInt is lenient — "Z" gives NaN, but so would a stray sign, so check
    // the character itself rather than trusting the parse.
    if (Number.isNaN(value) || !/[0-9a-fA-F]/.test(char)) return null
    bits += value.toString(2).padStart(4, '0')
  }

  const field = (spec: { at: number; bits: number }) =>
    parseInt(bits.slice(spec.at, spec.at + spec.bits), 2)

  if (field(FIELD.header) !== HEADER || field(FIELD.partition) !== PARTITION) return null

  return {
    filter: field(FIELD.filter),
    companyPrefix: String(field(FIELD.companyPrefix)).padStart(7, '0'),
    itemReference: String(field(FIELD.itemReference)).padStart(6, '0'),
    serial: field(FIELD.serial),
  }
}

/** True when this looks like an EPC rather than a printed barcode. */
export function isEpc(value: string): boolean {
  return /^[0-9A-Fa-f]{24}$/.test(value)
}

function toBits(value: number, width: number): string {
  return value.toString(2).padStart(width, '0')
}
