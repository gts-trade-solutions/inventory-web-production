import { describe, expect, it, vi } from 'vitest'
import { WebHidScanner, isWebHidAvailable } from './webhid'
import { Symbology, buildScannedDataReport } from './hid-pos'
import { ScanSource, type BarcodeScan } from '../types'

/**
 * The WebHID connector.
 *
 * Permission, claiming and reconnection genuinely need a device. What can be
 * tested is everything downstream of a report arriving — which is where a bug
 * would silently turn a scan into the wrong barcode rather than into no barcode
 * at all.
 */

const reportEvent = (bytes: Uint8Array, reportId = 0x02) => ({
  reportId,
  data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
})

describe('receiving reports', () => {
  it('turns a report into a scan with its symbology', () => {
    const scans: BarcodeScan[] = []
    const scanner = new WebHidScanner({ onScan: (scan) => scans.push(scan) })

    scanner.receive(reportEvent(buildScannedDataReport('8901234000045', Symbology.EAN13)))

    expect(scans).toHaveLength(1)
    expect(scans[0]).toMatchObject({
      data: '8901234000045',
      symbology: 'EAN13',
      source: ScanSource.WEB_HID,
    })
  })

  it('marks the source as WEB_HID, not the wedge', () => {
    // The source is recorded on the movement. A Tier 2 scan logged as a
    // keyboard scan would make a rollout impossible to diagnose.
    const scans: BarcodeScan[] = []
    const scanner = new WebHidScanner({ onScan: (scan) => scans.push(scan) })

    scanner.receive(reportEvent(buildScannedDataReport('ABC', Symbology.CODE128)))

    expect(scans[0]?.source).toBe(ScanSource.WEB_HID)
    expect(scans[0]?.at).toBeInstanceOf(Date)
  })

  it('does not fire for a partial barcode', () => {
    const onScan = vi.fn()
    const scanner = new WebHidScanner({ onScan })

    const bytes = new TextEncoder().encode('ABCDEFGHIJKL')
    const partial = new Uint8Array(4 + 6)
    partial[1] = 12
    partial[3] = Symbology.CODE128
    partial.set(bytes.subarray(0, 6), 4)

    expect(scanner.receive(reportEvent(partial))).toEqual({ kind: 'PARTIAL' })
    expect(onScan).not.toHaveBeenCalled()
  })

  it('reports what it ignored rather than swallowing it', () => {
    // A scanner producing reports we cannot read looks identical, from the
    // operator's side, to one that is not working at all — and those need
    // different fixes.
    const notices: string[] = []
    const scanner = new WebHidScanner({
      onScan: vi.fn(),
      onNotice: (message) => notices.push(message),
    })

    scanner.receive(reportEvent(new Uint8Array([0, 1])))

    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatch(/ignored/i)
  })

  it('reads a report offset inside a larger buffer', () => {
    // WebHID hands over a DataView, which may be a window onto a shared buffer.
    // Reading from byte 0 of the underlying buffer instead of the view's offset
    // produces a plausible-looking wrong barcode.
    const report = buildScannedDataReport('8901234000045', Symbology.EAN13)
    const padded = new Uint8Array(16 + report.length)
    padded.set(report, 16)

    const scans: BarcodeScan[] = []
    const scanner = new WebHidScanner({ onScan: (scan) => scans.push(scan) })
    scanner.receive({
      reportId: 0x02,
      data: new DataView(padded.buffer, 16, report.length),
    })

    expect(scans[0]?.data).toBe('8901234000045')
  })
})

describe('availability', () => {
  it('is false where navigator.hid does not exist', () => {
    // Node, and every non-Chromium browser. Tier 1 carries those.
    expect(isWebHidAvailable()).toBe(false)
  })

  it('reports unsupported rather than failing', async () => {
    // "Unsupported" and "failed" mean different things to the person reading
    // it: one is a browser fact, the other is a fault to chase.
    const statuses: unknown[] = []
    const scanner = new WebHidScanner({
      onScan: vi.fn(),
      onStatus: (status) => statuses.push(status),
    })

    const status = await scanner.connect()

    expect(status.kind).toBe('UNSUPPORTED')
    expect(status.kind === 'UNSUPPORTED' && status.reason).toMatch(/keyboard/i)
    expect(statuses).toHaveLength(1)
  })

  it('is not connected before connecting', () => {
    expect(new WebHidScanner({ onScan: vi.fn() }).connected).toBe(false)
  })
})

describe('disconnecting', () => {
  it('drops a half-received barcode', async () => {
    // Kept, it would be glued to the front of the next scan, producing a
    // barcode that matches nothing and looks like a scanner fault.
    const scans: BarcodeScan[] = []
    const scanner = new WebHidScanner({ onScan: (scan) => scans.push(scan) })

    const bytes = new TextEncoder().encode('ABCDEFGHIJKL')
    const partial = new Uint8Array(4 + 6)
    partial[1] = 12
    partial[3] = Symbology.CODE128
    partial.set(bytes.subarray(0, 6), 4)
    scanner.receive(reportEvent(partial))

    await scanner.disconnect()

    scanner.receive(reportEvent(buildScannedDataReport('8901234000045', Symbology.EAN13)))

    expect(scans).toHaveLength(1)
    expect(scans[0]?.data).toBe('8901234000045')
  })
})
