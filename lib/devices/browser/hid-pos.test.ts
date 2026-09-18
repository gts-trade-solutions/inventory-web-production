import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HID_POS_OPTIONS,
  HidPosParser,
  SCANNED_DATA_REPORT_ID,
  Symbology,
  buildScannedDataReport,
  symbologyName,
} from './hid-pos'

/**
 * HID POS report parsing.
 *
 * Tested against synthetic reports built from the published layout. What this
 * cannot prove is that a given Zebra model lays its reports out that way —
 * published descriptors are a good guide, not a guarantee. What it does prove
 * is that everything else works: chunking, padding, symbology, and rejecting
 * garbage rather than turning it into a barcode.
 */

const parse = (parser: HidPosParser, report: Uint8Array, reportId = SCANNED_DATA_REPORT_ID) =>
  parser.accept(reportId, report)

describe('a single report', () => {
  it('reads a barcode and its symbology', () => {
    const parser = new HidPosParser()
    const report = buildScannedDataReport('8901234000045', Symbology.EAN13)

    expect(parse(parser, report)).toEqual({
      kind: 'SCAN',
      data: '8901234000045',
      symbology: 'EAN13',
    })
  })

  it('distinguishes symbologies that look identical as text', () => {
    // The whole reason Tier 2 is worth having: a Code 128 and an EAN-13 with
    // the same digits are the same keystrokes on the wedge, and different
    // things on a shelf.
    const parser = new HidPosParser()

    const ean = parse(parser, buildScannedDataReport('8901234000045', Symbology.EAN13))
    const code128 = parse(parser, buildScannedDataReport('8901234000045', Symbology.CODE128))

    expect(ean.kind === 'SCAN' && ean.symbology).toBe('EAN13')
    expect(code128.kind === 'SCAN' && code128.symbology).toBe('CODE128')
  })

  it('ignores the zero padding a fixed-size report carries', () => {
    // The report is fixed-length; the declared length is what says where the
    // data stops. Padding left in would be submitted as part of the barcode and
    // match nothing.
    const parser = new HidPosParser()
    const report = buildScannedDataReport('ABC-123', Symbology.CODE128, { reportSize: 64 })

    expect(report).toHaveLength(64)
    expect(parse(parser, report)).toMatchObject({ data: 'ABC-123' })
  })

  it('reads a report that carries its own id in byte 0', () => {
    // WebHID strips the report id when the device uses ids and keeps it when it
    // does not. Both layouts appear in the wild.
    const parser = new HidPosParser()
    const report = buildScannedDataReport('8901234000045', Symbology.EAN13, {
      includeReportId: true,
    })

    expect(parser.accept(0, report)).toMatchObject({ data: '8901234000045' })
  })

  it('handles a 2D symbology with a long payload', () => {
    const parser = new HidPosParser()
    const payload = `01089012340000451721123110ABC${'X'.repeat(120)}`

    expect(parse(parser, buildScannedDataReport(payload, Symbology.PDF417))).toEqual({
      kind: 'SCAN',
      data: payload,
      symbology: 'PDF417',
    })
  })
})

describe('a barcode split across reports', () => {
  it('reassembles it', () => {
    // A GS1 DataBar with an AI string does not fit one report. A parser that
    // assumed one report per barcode would truncate exactly the labels that
    // carry the most information.
    const parser = new HidPosParser()
    const data = '0108901234000045' + '10LOT-0042' + '17261231'
    const bytes = new TextEncoder().encode(data)

    // First report declares the full length but carries only part of the data.
    const first = new Uint8Array(4 + 10)
    first[1] = bytes.length & 0xff
    first[2] = (bytes.length >> 8) & 0xff
    first[3] = Symbology.GS1_128
    first.set(bytes.subarray(0, 10), 4)

    expect(parse(parser, first)).toEqual({ kind: 'PARTIAL' })
    expect(parser.pending).toBe(true)

    const rest = new Uint8Array(4 + (bytes.length - 10))
    rest[1] = bytes.length & 0xff
    rest[2] = (bytes.length >> 8) & 0xff
    rest[3] = Symbology.GS1_128
    rest.set(bytes.subarray(10), 4)

    expect(parse(parser, rest)).toEqual({
      kind: 'SCAN',
      data,
      symbology: 'GS1_128',
    })
    expect(parser.pending).toBe(false)
  })

  it('keeps the symbology from the first report', () => {
    const parser = new HidPosParser()
    const bytes = new TextEncoder().encode('ABCDEFGHIJKL')

    const first = new Uint8Array(4 + 6)
    first[1] = 12
    first[3] = Symbology.QR
    first.set(bytes.subarray(0, 6), 4)
    parse(parser, first)

    const second = new Uint8Array(4 + 6)
    second[1] = 12
    // A continuation report claiming a different symbology must not change it.
    second[3] = Symbology.CODE128
    second.set(bytes.subarray(6), 4)

    expect(parse(parser, second)).toMatchObject({ symbology: 'QR' })
  })
})

describe('rejecting what is not a scan', () => {
  it('ignores a report that is too short to hold a header', () => {
    const parser = new HidPosParser()
    expect(parse(parser, new Uint8Array([0, 5]))).toMatchObject({ kind: 'IGNORED' })
  })

  it('ignores a report from another collection', () => {
    const parser = new HidPosParser()
    const result = parser.accept(0x07, buildScannedDataReport('X', Symbology.CODE128))

    expect(result).toMatchObject({ kind: 'IGNORED' })
    expect(result.kind === 'IGNORED' && result.reason).toMatch(/not scanned data/)
  })

  it('ignores a report declaring no data', () => {
    const parser = new HidPosParser()
    expect(parse(parser, new Uint8Array([0, 0, 0, Symbology.EAN13, 0, 0]))).toMatchObject({
      kind: 'IGNORED',
    })
  })

  it('refuses a length no barcode could have', () => {
    // A length field larger than any real barcode means the report layout was
    // misread, not that somebody scanned a novel.
    const parser = new HidPosParser()
    const report = new Uint8Array(8)
    report[1] = 0xff
    report[2] = 0xff
    report[3] = Symbology.CODE128

    const result = parse(parser, report)
    expect(result.kind).toBe('IGNORED')
    expect(result.kind === 'IGNORED' && result.reason).toMatch(/not a barcode/)
  })

  it('says why, for the device console', () => {
    // "Ignored" with no reason is indistinguishable from a scanner that is not
    // working at all, which is the thing a rollout most needs to tell apart.
    const parser = new HidPosParser()
    const result = parse(parser, new Uint8Array([0, 1]))

    expect(result.kind === 'IGNORED' && result.reason.length).toBeGreaterThan(10)
  })
})

describe('recovering', () => {
  it('drops a half-received barcode on reset', () => {
    // Without this, the next scan after a dropped connection is glued onto the
    // tail of the one before — a barcode that matches nothing and looks like a
    // scanner fault.
    const parser = new HidPosParser()
    const bytes = new TextEncoder().encode('ABCDEFGHIJKL')

    const first = new Uint8Array(4 + 6)
    first[1] = 12
    first[3] = Symbology.CODE128
    first.set(bytes.subarray(0, 6), 4)
    parse(parser, first)
    expect(parser.pending).toBe(true)

    parser.reset()
    expect(parser.pending).toBe(false)

    expect(parse(parser, buildScannedDataReport('8901234000045', Symbology.EAN13))).toMatchObject({
      data: '8901234000045',
    })
  })

  it('is usable again after an oversized report', () => {
    const parser = new HidPosParser()
    const bad = new Uint8Array(8)
    bad[1] = 0xff
    bad[2] = 0xff
    parse(parser, bad)

    expect(parse(parser, buildScannedDataReport('OK-1', Symbology.CODE128))).toMatchObject({
      data: 'OK-1',
    })
  })
})

describe('symbologyName', () => {
  it('names the ones a warehouse meets', () => {
    expect(symbologyName(Symbology.EAN13)).toBe('EAN13')
    expect(symbologyName(Symbology.DATAMATRIX)).toBe('DATAMATRIX')
  })

  it('reports an unknown code as hex rather than guessing', () => {
    // "0x4B" tells somebody what to look up. "UNKNOWN" tells them nothing.
    expect(symbologyName(0x4b)).toBe('0x4B')
  })
})

describe('defaults', () => {
  it('caps at a length no barcode exceeds', () => {
    expect(DEFAULT_HID_POS_OPTIONS.maxLength).toBeGreaterThan(2000)
  })
})
