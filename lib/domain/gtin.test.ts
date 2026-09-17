import { describe, expect, it } from 'vitest'
import { GtinError, checkDigit, ean13, isValidEan13, normaliseBarcode } from './gtin'
import {
  decode,
  encode,
  fromGtin13,
  isEpc,
  MAX_SERIAL,
  Sgtin96Error,
  gtin13Of,
  FILTER_POS_ITEM,
} from './sgtin96'

/**
 * Ported from the mobile app's GtinTest.kt and Sgtin96Test.kt. The assertions
 * are the same values, so a divergence between the two implementations shows up
 * as a failing test rather than as a barcode that scans on one client and not
 * the other.
 */

describe('GTIN-13', () => {
  // Ported verbatim from GtinTest.computesTheGs1CheckDigit
  it('computes the GS1 check digit', () => {
    expect(checkDigit('400638133393')).toBe(1)
    expect(ean13('400638133393')).toBe('4006381333931')
  })

  // Ported from GtinTest.validatesEan13Codes
  it('validates EAN-13 codes', () => {
    expect(isValidEan13('4006381333931')).toBe(true)
    expect(isValidEan13('4006381333932')).toBe(false)
    expect(isValidEan13('12345')).toBe(false)
  })

  it('rejects a body that is not 12 digits', () => {
    expect(() => checkDigit('4006381333')).toThrow(GtinError)
    expect(() => checkDigit('40063813339X')).toThrow(GtinError)
  })

  it('rejects non-digits and wrong lengths', () => {
    for (const bad of ['', '400638133393', 'abcdefghijklm', '40063813339311']) {
      expect(isValidEan13(bad)).toBe(false)
    }
  })

  it('round-trips every check digit 0-9', () => {
    // Exercises the (10 - sum % 10) % 10 wrap, where a sum ending in 0 must give
    // 0 rather than 10.
    for (let i = 0; i < 10; i++) {
      const body = `89012340000${i}`
      expect(isValidEan13(ean13(body))).toBe(true)
    }
  })

  describe('normaliseBarcode', () => {
    it('expands a 12-digit UPC-A to its EAN-13', () => {
      const upc = '400638133393'
      // Only when the result is actually valid, which it is not here.
      expect(normaliseBarcode(upc)).toBe(upc)

      const realUpc = '036000291452'
      expect(normaliseBarcode(realUpc)).toBe('0036000291452')
    })

    it('strips the indicator zero from a GTIN-14', () => {
      expect(normaliseBarcode('08901234000047')).toBe('8901234000047')
    })

    it('leaves a GTIN-14 with a real indicator digit alone', () => {
      // Indicator 1 is a case, not the same trade item as the piece.
      expect(normaliseBarcode('18901234000044')).toBe('18901234000044')
    })

    it('trims whitespace and passes non-numeric codes through', () => {
      expect(normaliseBarcode('  8901234000047  ')).toBe('8901234000047')
      expect(normaliseBarcode(' ABC-123 ')).toBe('ABC-123')
    })
  })
})

describe('SGTIN-96', () => {
  // Ported verbatim from Sgtin96Test.matchesTheGs1TagDataStandardExample.
  // urn:epc:tag:sgtin-96:3.0614141.812345.6789 — the published worked example.
  it('matches the GS1 Tag Data Standard example', () => {
    expect(encode('0614141', '812345', 6789, 3)).toBe('3074257BF7194E4000001A85')
  })

  // Ported from Sgtin96Test.roundTripsAGtinAndSerial
  it('round-trips a GTIN and serial', () => {
    const gtin = ean13('890123400004')

    const decoded = decode(fromGtin13(gtin, 100_001))

    expect(decoded).not.toBeNull()
    expect(gtin13Of(decoded!)).toBe(gtin)
    expect(decoded!.serial).toBe(100_001)
    expect(decoded!.filter).toBe(FILTER_POS_ITEM)
  })

  // Ported from Sgtin96Test.rejectsDataThatIsNotSgtin96
  it('rejects data that is not SGTIN-96', () => {
    // A valid EPC, but SGTIN-198 rather than -96.
    expect(decode('E28011700000020A1B2C3D4E')).toBeNull()
    // Too short.
    expect(decode('3074')).toBeNull()
    // Right length, but not hexadecimal.
    expect(decode('3074257BF7194E4000001AZZ')).toBeNull()
  })

  it('always produces 24 uppercase hex characters', () => {
    for (const serial of [0, 1, 6789, 1_000_000, MAX_SERIAL]) {
      const epc = encode('0614141', '812345', serial)
      expect(epc).toMatch(/^[0-9A-F]{24}$/)
    }
  })

  it('carries the full 38-bit serial range without losing precision', () => {
    // 2^38-1 exceeds a 32-bit integer, so a bitwise implementation would wrap
    // here. This is the test that catches it.
    const decoded = decode(encode('0614141', '812345', MAX_SERIAL))
    expect(decoded?.serial).toBe(MAX_SERIAL)
  })

  it('distinguishes adjacent serials, so two units never share an EPC', () => {
    const gtin = ean13('890123400004')
    expect(fromGtin13(gtin, 500_000)).not.toBe(fromGtin13(gtin, 500_001))
  })

  it('rejects out-of-range input', () => {
    expect(() => encode('61414', '812345', 1)).toThrow(Sgtin96Error)
    expect(() => encode('0614141', '81234', 1)).toThrow(Sgtin96Error)
    expect(() => encode('0614141', '812345', -1)).toThrow(Sgtin96Error)
    expect(() => encode('0614141', '812345', MAX_SERIAL + 1)).toThrow(Sgtin96Error)
    expect(() => encode('0614141', '812345', 1, 8)).toThrow(Sgtin96Error)
    expect(() => fromGtin13('4006381333932', 1)).toThrow(Sgtin96Error)
  })

  it('returns no GTIN for a packaging level above the piece', () => {
    // Indicator digit 1 is a case; there is no EAN-13 for it.
    const decoded = decode(encode('0614141', '112345', 1))
    expect(gtin13Of(decoded!)).toBeNull()
  })

  it('tells an EPC apart from a printed barcode', () => {
    expect(isEpc('3074257BF7194E4000001A85')).toBe(true)
    expect(isEpc('8901234000047')).toBe(false)
    expect(isEpc('')).toBe(false)
  })
})
