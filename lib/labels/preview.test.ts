import { describe, expect, it } from 'vitest'
import { Ean13Error, ean13Bars, ean13Groups, normalise } from './ean13-bars'
import { previewZpl } from './preview'
import { ean13 } from '@/lib/domain/gtin'

/**
 * The label preview.
 *
 * It exists so somebody can see what will print before a roll of labels is
 * committed, which only means anything if it is parsed from the same bytes the
 * printer gets.
 */

describe('EAN-13 bars', () => {
  it('produces 95 modules', () => {
    // 3 guard + 42 + 5 centre + 42 + 3 guard. Any other length is a bug.
    expect(ean13Bars('890123400004')).toHaveLength(95)
  })

  it('starts and ends with a guard pattern', () => {
    const bars = ean13Bars('890123400004')

    expect(bars.startsWith('101')).toBe(true)
    expect(bars.endsWith('101')).toBe(true)
    expect(bars.slice(45, 50)).toBe('01010')
  })

  it('encodes the first digit through parity, not bars', () => {
    // The first digit is never drawn. It is carried by WHICH parity each of the
    // next six digits uses — get that table wrong and the barcode looks perfect
    // and scans as a different product.
    const zeroLeading = ean13Bars('012345678905')
    const nineLeading = ean13Bars('912345678900')

    // Same digits 2-13, different parity pattern, so different bars.
    expect(zeroLeading).not.toBe(nineLeading)
  })

  it('matches a known pattern for a leading zero', () => {
    // With a leading 0 every left digit uses odd parity, so digit 1 is its
    // L-code 0011001 immediately after the guard.
    expect(ean13Bars('012345678905').slice(3, 10)).toBe('0011001')
  })

  it('computes the check digit for twelve digits', () => {
    expect(normalise('890123400004')).toBe(ean13('890123400004'))
  })

  it('refuses thirteen digits with a wrong check digit', () => {
    // The mobile MVP's fixtures carry 8901234000047, whose check digit is
    // wrong. Printing it would produce labels no scanner reads.
    expect(() => normalise('8901234000047')).toThrow(Ean13Error)
  })

  it('refuses anything that is not 12 or 13 digits', () => {
    expect(() => ean13Bars('12345')).toThrow(Ean13Error)
    expect(() => ean13Bars('89012340000A')).toThrow(Ean13Error)
  })

  it('groups the digits the way they are printed', () => {
    expect(ean13Groups('890123400004')).toEqual([
      '8',
      '901234',
      '00004' + ean13('890123400004').slice(12),
    ])
  })
})

describe('previewZpl', () => {
  const ITEM_LABEL = [
    '^XA^CI28^PW812^LL406',
    '^FO30,30^A0N,40,40^FB752,2,0,L^FDCordless drill^FS',
    '^FO30,125^A0N,28,28^FDSKU TLS-0015   LOC A-01^FS',
    '^FO30,175^BY3,2,150^BEN,150,Y,N^FD890123400004^FS',
    '^XZ',
  ].join('\n')

  it('reads the label size from the ZPL', () => {
    const [label] = previewZpl(ITEM_LABEL)

    expect(label?.widthDots).toBe(812)
    expect(label?.heightDots).toBe(406)
  })

  it('places text where the ZPL puts it', () => {
    const [label] = previewZpl(ITEM_LABEL)
    const text = label!.elements.filter((element) => element.kind === 'TEXT')

    expect(text[0]).toMatchObject({ x: 30, y: 30, height: 40, text: 'Cordless drill' })
    expect(text[1]).toMatchObject({ x: 30, y: 125, height: 28 })
  })

  it('carries the field block width, so wrapping matches', () => {
    const [label] = previewZpl(ITEM_LABEL)
    const first = label!.elements.find((element) => element.kind === 'TEXT')

    expect(first).toMatchObject({ blockWidth: 752 })
  })

  it('draws the barcode with real bars', () => {
    const [label] = previewZpl(ITEM_LABEL)
    const barcode = label!.elements.find((element) => element.kind === 'BARCODE')

    expect(barcode).toMatchObject({ x: 30, y: 175, symbology: 'EAN13', moduleWidth: 3 })
    expect(barcode && barcode.kind === 'BARCODE' && barcode.bars).toHaveLength(95)
  })

  it('says so rather than faking Code 128', () => {
    // Code 128 encodes through shifting character sets. An approximation would
    // look right and scan as nothing.
    const [label] = previewZpl('^XA^FO20,85^BY2,2,80^BCN,80,Y,N,N^FDA-01^FS^XZ')
    const barcode = label!.elements.find((element) => element.kind === 'BARCODE')

    expect(barcode).toMatchObject({ symbology: 'CODE128', bars: null })
    expect(barcode && barcode.kind === 'BARCODE' && barcode.note).toMatch(/not drawn/i)
  })

  it('reports a barcode it cannot encode instead of dropping it', () => {
    const [label] = previewZpl('^XA^BEN,150,Y,N^FDnot-a-barcode^FS^XZ')
    const barcode = label!.elements.find((element) => element.kind === 'BARCODE')

    expect(barcode && barcode.kind === 'BARCODE' && barcode.note).toMatch(/12 or 13 digits/)
  })

  it('reads the EPC out of an RFID format, and does not print it as text', () => {
    const zpl = '^XA^FO30,30^A0N,40,40^FDDrill^FS^RS8\n^RFW,H^FD30361F49C800004000000001^FS\n^XZ'
    const [label] = previewZpl(zpl)

    expect(label?.epc).toBe('30361F49C800004000000001')
    // The tag data must not appear as a printed line — it is written to the
    // chip, not onto the label.
    expect(label!.elements.map((e) => e.kind === 'TEXT' && e.text)).not.toContain(
      '30361F49C800004000000001',
    )
  })

  it('returns one preview per format', () => {
    const previews = previewZpl(`${ITEM_LABEL}\n${ITEM_LABEL}`)
    expect(previews).toHaveLength(2)
  })

  it('reads the copy count', () => {
    const [label] = previewZpl('^XA^FO0,0^FDx^FS^PQ7^XZ')
    expect(label?.copies).toBe(7)
  })

  it('names commands it did not draw rather than dropping them', () => {
    // An operator approving a layout should know the preview is incomplete.
    const [label] = previewZpl('^XA^GB100,100,3^FS^XZ')

    expect(label?.unsupported).toContain('^GB')
  })

  it('is empty for something that is not a label', () => {
    expect(previewZpl('hello')).toEqual([])
  })
})
