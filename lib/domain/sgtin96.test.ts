import { describe, expect, it } from 'vitest'
import { ean13 } from './gtin'
import {
  FILTER_POS_ITEM,
  MAX_SERIAL,
  Sgtin96Error,
  decode,
  encode,
  fromGtin13,
  gtin13Of,
  isEpc,
} from './sgtin96'

/**
 * SGTIN-96 encoding.
 *
 * This is the only code in the system whose output is judged by hardware we do
 * not own: an EPC we pack wrongly is a tag no reader resolves, and we would not
 * find out until a Zebra reader is in the room. So the encoder is pinned to the
 * GS1 Tag Data Standard's own worked example rather than to our own output.
 */

describe('encode', () => {
  it('matches the GS1 Tag Data Standard worked example', () => {
    // urn:epc:tag:sgtin-96:3.0614141.812345.6789 — from the standard itself, and
    // the same vector the Kotlin implementation is pinned to (Sgtin96Test.kt).
    // If this line ever fails, the bit layout is wrong, not the test.
    expect(encode('0614141', '812345', 6789, 3)).toBe('3074257BF7194E4000001A85')
  })

  it('agrees with an independent BigInt packing', () => {
    // The implementation assembles a 96-bit value as a string because JavaScript's
    // bitwise operators are 32-bit. This packs the same fields with BigInt
    // arithmetic instead — a different method, so it catches a slipped offset
    // rather than reproducing one.
    const pack = (prefix: string, reference: string, serial: number, filter: number) => {
      let value = 0x30n
      value = (value << 3n) | BigInt(filter)
      value = (value << 3n) | 5n
      value = (value << 24n) | BigInt(prefix)
      value = (value << 20n) | BigInt(reference)
      value = (value << 38n) | BigInt(serial)
      return value.toString(16).toUpperCase().padStart(24, '0')
    }

    const cases: Array<[string, string, number, number]> = [
      ['0614141', '812345', 6789, 3],
      ['8901234', '000004', 1, FILTER_POS_ITEM],
      ['0000001', '000000', 0, 0],
      ['9999999', '999999', MAX_SERIAL, 7],
    ]

    for (const [prefix, reference, serial, filter] of cases) {
      expect(encode(prefix, reference, serial, filter)).toBe(pack(prefix, reference, serial, filter))
    }
  })

  it('produces 24 hex digits whatever the inputs', () => {
    expect(encode('0000001', '000000', 0)).toHaveLength(24)
    expect(encode('9999999', '999999', MAX_SERIAL)).toHaveLength(24)
  })

  it('refuses a company prefix that is not 7 digits', () => {
    // Partition 5 only. Silently truncating would mint tags belonging to another
    // company's prefix.
    expect(() => encode('061414', '812345', 1)).toThrow(Sgtin96Error)
    expect(() => encode('06141411', '812345', 1)).toThrow(Sgtin96Error)
    expect(() => encode('06141X1', '812345', 1)).toThrow(Sgtin96Error)
  })

  it('refuses an item reference that is not 6 digits', () => {
    expect(() => encode('0614141', '81234', 1)).toThrow(Sgtin96Error)
    expect(() => encode('0614141', '8123456', 1)).toThrow(Sgtin96Error)
  })

  it('refuses a serial the 38-bit field cannot hold', () => {
    expect(() => encode('0614141', '812345', MAX_SERIAL + 1)).toThrow(Sgtin96Error)
    expect(() => encode('0614141', '812345', -1)).toThrow(Sgtin96Error)
    expect(() => encode('0614141', '812345', 1.5)).toThrow(Sgtin96Error)
  })

  it('accepts the widest serial the field holds', () => {
    // 2^38 - 1 exactly. One past it must fail, this must not.
    expect(decode(encode('0614141', '812345', MAX_SERIAL))?.serial).toBe(MAX_SERIAL)
  })

  it('refuses a filter outside 0-7', () => {
    expect(() => encode('0614141', '812345', 1, 8)).toThrow(Sgtin96Error)
    expect(() => encode('0614141', '812345', 1, -1)).toThrow(Sgtin96Error)
  })
})

describe('decode', () => {
  it('reverses the standard example', () => {
    const decoded = decode('3074257BF7194E4000001A85')

    expect(decoded).toEqual({
      filter: 3,
      companyPrefix: '0614141',
      itemReference: '812345',
      serial: 6789,
    })
  })

  it('keeps leading zeros on the company prefix', () => {
    // The prefix is a numeric field on the wire, so 0614141 comes back as
    // 614141 unless it is padded. A dropped leading zero is a different company.
    expect(decode(encode('0000123', '000456', 7))).toMatchObject({
      companyPrefix: '0000123',
      itemReference: '000456',
    })
  })

  it('rejects an EPC that is not a partition-5 SGTIN-96', () => {
    // A plain 96-bit tag ID, not an SGTIN — readers return these too.
    expect(decode('E28011700000020A1B2C3D4E')).toBeNull()
  })

  it('rejects a truncated read', () => {
    expect(decode('3074')).toBeNull()
    expect(decode('')).toBeNull()
  })

  it('rejects non-hex characters', () => {
    // parseInt would take '1A85' from '1AZZ' and carry on; a garbled read must
    // not silently resolve to a real unit.
    expect(decode('3074257BF7194E4000001AZZ')).toBeNull()
    expect(decode('3074257BF7194E400000+A85')).toBeNull()
  })

  it('accepts lower-case hex, which some readers emit', () => {
    expect(decode('3074257bf7194e4000001a85')?.serial).toBe(6789)
  })
})

describe('fromGtin13', () => {
  it('round-trips a GTIN and serial', () => {
    // Mirrors Sgtin96Test.roundTripsAGtinAndSerial, so web and mobile agree on
    // what a tag for the same unit looks like.
    const gtin = ean13('890123400004')
    const decoded = decode(fromGtin13(gtin, 100_001))

    expect(decoded).not.toBeNull()
    expect(gtin13Of(decoded!)).toBe(gtin)
    expect(decoded!.serial).toBe(100_001)
    expect(decoded!.filter).toBe(FILTER_POS_ITEM)
  })

  it('refuses a GTIN with a bad check digit', () => {
    // The mobile MVP's own fixtures carry 8901234000047, whose check digit is
    // wrong. Encoding it would put an unverifiable identity on a physical label.
    expect(() => fromGtin13('8901234000047', 1)).toThrow(Sgtin96Error)
  })

  it('gives every serial of an item a distinct EPC', () => {
    const gtin = ean13('890123400004')
    const epcs = new Set(Array.from({ length: 200 }, (_, i) => fromGtin13(gtin, i + 1)))

    expect(epcs.size).toBe(200)
  })
})

describe('gtin13Of', () => {
  it('returns null for packaging levels other than the base unit', () => {
    // Indicator digit 1-8 is a case or pallet, which has no GTIN-13. Returning
    // one anyway would report a pallet as a single unit.
    const caseLevel = decode(encode('0614141', '812345', 1))
    expect(gtin13Of(caseLevel!)).toBeNull()
  })

  it('returns the GTIN-13 for indicator digit 0', () => {
    const decoded = decode(encode('8901234', '000004', 1))
    expect(gtin13Of(decoded!)).toBe(ean13('890123400004'))
  })
})

describe('isEpc', () => {
  it('distinguishes a tag read from a printed barcode', () => {
    expect(isEpc('3074257BF7194E4000001A85')).toBe(true)
    expect(isEpc('3074257bf7194e4000001a85')).toBe(true)
    // An EAN-13 is 13 digits, and 13 digits is not 24.
    expect(isEpc('8901234000045')).toBe(false)
    expect(isEpc('3074257BF7194E4000001A8')).toBe(false)
    expect(isEpc('')).toBe(false)
  })
})
