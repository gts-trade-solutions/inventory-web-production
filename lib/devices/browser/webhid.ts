import { HidPosParser, type HidReportResult } from './hid-pos'
import { ScanSource, type BarcodeScan } from '../types'

/**
 * Tier 2: a scanner claimed directly over WebHID.
 *
 * What it buys over the keyboard wedge is symbology and device identity, and
 * freedom from the timing heuristic. What it costs is that it only exists in
 * Chromium, needs a user gesture, and needs the scanner in HID POS mode rather
 * than keyboard mode.
 *
 * So it is offered, never required. If it is unavailable, refused, or the
 * scanner is in keyboard mode, Tier 1 is still running underneath and every
 * workflow still works (DEVICE_INTEGRATION §4, WADR-013).
 *
 * The byte parsing lives in `hid-pos.ts` and is tested there. This file is the
 * part that genuinely cannot be tested without a device: permission, claiming,
 * and reconnection.
 */

/** HID usage page for Point of Sale devices, and the barcode scanner usage. */
const POS_USAGE_PAGE = 0x008c
const BARCODE_SCANNER_USAGE = 0x0002

/** Zebra's USB vendor id, for a friendlier picker. */
const ZEBRA_VENDOR_ID = 0x05e0

export type WebHidStatus =
  | { kind: 'UNSUPPORTED'; reason: string }
  | { kind: 'IDLE' }
  | { kind: 'CONNECTED'; name: string }
  | { kind: 'FAILED'; reason: string }

export interface WebHidEvents {
  onScan: (scan: BarcodeScan) => void
  /** Reports that did not become a scan, for the device console. */
  onNotice?: (message: string) => void
  onStatus?: (status: WebHidStatus) => void
}

/** Whether this browser can do Tier 2 at all. */
export function isWebHidAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'hid' in navigator
}

interface HidDeviceLike {
  productName?: string
  opened: boolean
  open(): Promise<void>
  close(): Promise<void>
  addEventListener(type: 'inputreport', listener: (event: HidInputReportLike) => void): void
  removeEventListener(type: 'inputreport', listener: (event: HidInputReportLike) => void): void
}

interface HidInputReportLike {
  reportId: number
  data: DataView
}

interface HidLike {
  requestDevice(options: {
    filters: Array<{ vendorId?: number; usagePage?: number; usage?: number }>
  }): Promise<HidDeviceLike[]>
  getDevices(): Promise<HidDeviceLike[]>
}

/**
 * A scanner connection.
 *
 * Deliberately a class with explicit lifecycle rather than a hook, matching
 * `KeyboardWedge`: the same object has to work in a React provider and in a
 * plain test harness.
 */
export class WebHidScanner {
  private device: HidDeviceLike | null = null
  private readonly parser = new HidPosParser()
  private listener: ((event: HidInputReportLike) => void) | null = null

  constructor(private readonly events: WebHidEvents) {}

  get connected(): boolean {
    return this.device !== null && this.device.opened
  }

  /**
   * Asks the operator to pick a scanner.
   *
   * MUST be called from a click. Browsers refuse the permission prompt
   * otherwise, and the refusal looks exactly like "no scanner found" — so the
   * caller wires this to a button, never to page load.
   */
  async connect(): Promise<WebHidStatus> {
    if (!isWebHidAvailable()) {
      const status: WebHidStatus = {
        kind: 'UNSUPPORTED',
        reason:
          'This browser cannot claim a scanner directly. Scanning still works — pair the scanner as a keyboard.',
      }
      this.events.onStatus?.(status)
      return status
    }

    const hid = (navigator as unknown as { hid: HidLike }).hid

    try {
      // Already-granted devices first, so a reload does not re-prompt.
      const granted = await hid.getDevices()
      const device =
        granted.find(isScanner) ??
        (
          await hid.requestDevice({
            filters: [
              {
                vendorId: ZEBRA_VENDOR_ID,
                usagePage: POS_USAGE_PAGE,
                usage: BARCODE_SCANNER_USAGE,
              },
              // Any POS scanner, not just Zebra's — a warehouse rarely has one
              // brand, and refusing the others buys nothing.
              { usagePage: POS_USAGE_PAGE, usage: BARCODE_SCANNER_USAGE },
            ],
          })
        )[0]

      if (!device) {
        // Cancelling the picker is not an error. Saying "failed" would send
        // somebody looking for a fault that is not there.
        const status: WebHidStatus = { kind: 'IDLE' }
        this.events.onStatus?.(status)
        return status
      }

      return await this.attach(device)
    } catch (error) {
      const status: WebHidStatus = {
        kind: 'FAILED',
        reason:
          error instanceof Error
            ? error.message
            : 'The scanner could not be opened. It may be in keyboard mode, or claimed by another tab.',
      }
      this.events.onStatus?.(status)
      return status
    }
  }

  /** Reattaches to a scanner already granted, with no prompt. */
  async reconnect(): Promise<WebHidStatus> {
    if (!isWebHidAvailable()) return { kind: 'UNSUPPORTED', reason: 'WebHID is not available.' }

    const hid = (navigator as unknown as { hid: HidLike }).hid
    const device = (await hid.getDevices()).find(isScanner)
    if (!device) return { kind: 'IDLE' }

    return this.attach(device)
  }

  async disconnect(): Promise<void> {
    const device = this.device
    this.device = null

    // Any half-received barcode dies with the connection. Kept, it would be
    // glued to the front of the next scan.
    this.parser.reset()

    if (device && this.listener) device.removeEventListener('inputreport', this.listener)
    this.listener = null

    if (device?.opened) {
      try {
        await device.close()
      } catch {
        // The device was already gone. Nothing useful left to do.
      }
    }

    this.events.onStatus?.({ kind: 'IDLE' })
  }

  private async attach(device: HidDeviceLike): Promise<WebHidStatus> {
    if (!device.opened) await device.open()

    const listener = (event: HidInputReportLike) => this.receive(event)
    device.addEventListener('inputreport', listener)

    this.device = device
    this.listener = listener

    const status: WebHidStatus = { kind: 'CONNECTED', name: device.productName || 'Scanner' }
    this.events.onStatus?.(status)
    return status
  }

  /** Exposed so a test harness can feed reports without a device. */
  receive(event: HidInputReportLike): HidReportResult {
    const bytes = new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength)
    const result = this.parser.accept(event.reportId, bytes)

    if (result.kind === 'SCAN') {
      this.events.onScan({
        data: result.data,
        symbology: result.symbology,
        source: ScanSource.WEB_HID,
        at: new Date(),
      })
    } else if (result.kind === 'IGNORED') {
      // Surfaced rather than swallowed. A scanner producing reports we cannot
      // read looks identical, from the operator's side, to one that is not
      // working at all — and those need different fixes.
      this.events.onNotice?.(`Ignored a report: ${result.reason}`)
    }

    return result
  }
}

function isScanner(device: HidDeviceLike): boolean {
  // getDevices() returns everything previously granted on this origin, which
  // may include devices that are not scanners at all.
  const collections = (
    device as unknown as {
      collections?: Array<{ usagePage?: number; usage?: number }>
    }
  ).collections

  if (!collections) return false

  return collections.some(
    (collection) =>
      collection.usagePage === POS_USAGE_PAGE && collection.usage === BARCODE_SCANNER_USAGE,
  )
}
