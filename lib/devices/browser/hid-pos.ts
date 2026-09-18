/**
 * Tier 2 scanning: parsing HID Point-of-Sale input reports.
 *
 * A Zebra scanner in HID POS mode sends the barcode as structured binary rather
 * than as keystrokes, which buys two things the keyboard wedge can never
 * provide: the SYMBOLOGY (so a Code 128 and an EAN-13 that happen to be the
 * same digits are distinguishable) and freedom from the timing heuristic.
 *
 * It is Chromium-only and needs a user gesture to grant permission, which is
 * exactly why it is Tier 2 and never required: Tier 1 still runs every workflow
 * (DEVICE_INTEGRATION §4, WADR-013).
 *
 * This module is pure. The browser plumbing lives in `webhid.ts`, so the part
 * that can be wrong — the byte layout — is testable against synthetic reports
 * built from published descriptors.
 *
 * Honest limit: published descriptors are a good guide, not a guarantee. A model
 * that lays its report out differently will parse wrongly here, and finding that
 * out needs the device in hand (DEVICE_INTEGRATION §11.2). What this buys is
 * that everything else — framing, chunking, symbology decoding, garbage
 * rejection — is already known to work when one arrives.
 */

/**
 * The HID POS scanned-data report.
 *
 *   byte 0      report id (0x02 for scanned data)
 *   bytes 1..2  data length, little-endian
 *   byte 3      symbology identifier
 *   bytes 4..   barcode data, UTF-8
 *
 * The report is fixed-length and zero-padded; the declared length is what says
 * where the data actually stops.
 */
export const SCANNED_DATA_REPORT_ID = 0x02

const HEADER_BYTES = 4

/**
 * Symbology identifiers, from the USB HID Point of Sale usage tables.
 *
 * Only the ones a warehouse actually meets. An unknown value is reported as
 * its hex code rather than guessed at — "0x4B" tells somebody what to look up,
 * where "UNKNOWN" tells them nothing.
 */
const SYMBOLOGIES: Record<number, string> = {
  0x00: 'UNKNOWN',
  0x0b: 'CODE39',
  0x0c: 'CODE128',
  0x0d: 'CODE93',
  0x0e: 'CODABAR',
  0x0f: 'ITF',
  0x10: 'EAN13',
  0x11: 'EAN8',
  0x12: 'UPCA',
  0x13: 'UPCE',
  0x14: 'GS1_128',
  0x15: 'GS1_DATABAR',
  0x16: 'QR',
  0x17: 'DATAMATRIX',
  0x18: 'PDF417',
  0x19: 'AZTEC',
  0x1a: 'MAXICODE',
}

export function symbologyName(code: number): string {
  return SYMBOLOGIES[code] ?? `0x${code.toString(16).toUpperCase().padStart(2, '0')}`
}

export type HidReportResult =
  /** A complete barcode. */
  | { kind: 'SCAN'; data: string; symbology: string }
  /** A valid report that did not complete a barcode yet. */
  | { kind: 'PARTIAL' }
  /** Not something we can read. `reason` is for the device console. */
  | { kind: 'IGNORED'; reason: string }

export interface HidPosOptions {
  /** Longer than this is not a barcode we will accept. */
  maxLength: number
}

export const DEFAULT_HID_POS_OPTIONS: HidPosOptions = { maxLength: 4096 }

/**
 * Reassembles HID POS reports into barcodes.
 *
 * Stateful because a long barcode — a GS1 DataBar with an AI string, a PDF417
 * on a supplier's pallet label — does not fit one report and arrives in
 * several. A parser that assumed one report per barcode would silently truncate
 * exactly the labels that carry the most information.
 */
export class HidPosParser {
  private buffer = ''
  private symbology = 0
  private expected = 0

  constructor(private readonly options: HidPosOptions = DEFAULT_HID_POS_OPTIONS) {}

  /** Feeds one input report. `reportId` is separate on WebHID. */
  accept(reportId: number, data: Uint8Array): HidReportResult {
    if (reportId !== SCANNED_DATA_REPORT_ID && reportId !== 0) {
      return { kind: 'IGNORED', reason: `report ${reportId} is not scanned data` }
    }

    // WebHID strips the report id from `data` when the device uses report ids,
    // and keeps it when it does not. Both layouts appear in the wild, so the
    // header is located by checking whether byte 0 looks like the id.
    const body = data[0] === SCANNED_DATA_REPORT_ID && reportId === 0 ? data.subarray(1) : data

    if (body.length < HEADER_BYTES) {
      return { kind: 'IGNORED', reason: `report is ${body.length} bytes, too short to be a scan` }
    }

    const declared = body[1]! | (body[2]! << 8)
    const symbology = body[3]!
    const available = body.length - HEADER_BYTES

    if (declared === 0) {
      return { kind: 'IGNORED', reason: 'report declares no data' }
    }
    if (declared > this.options.maxLength) {
      // A length field larger than any real barcode means a misread report
      // layout, not a very long barcode.
      this.reset()
      return { kind: 'IGNORED', reason: `report declares ${declared} bytes, which is not a barcode` }
    }

    // A fresh report starts a new barcode; the declared length tells us whether
    // more reports are coming.
    if (this.buffer.length === 0) {
      this.symbology = symbology
      this.expected = declared
    }

    const take = Math.min(declared - this.buffer.length, available)
    if (take <= 0) {
      return { kind: 'IGNORED', reason: 'report carries no usable bytes' }
    }

    this.buffer += decode(body.subarray(HEADER_BYTES, HEADER_BYTES + take))

    if (this.buffer.length < this.expected) return { kind: 'PARTIAL' }

    const result: HidReportResult = {
      kind: 'SCAN',
      data: this.buffer,
      symbology: symbologyName(this.symbology),
    }
    this.reset()
    return result
  }

  /**
   * Abandons a half-received barcode.
   *
   * Called when the device disconnects. Without it, the next scan after a
   * dropped connection would be glued onto the tail of the one before —
   * producing a barcode that scans as nothing and looks like a scanner fault.
   */
  reset(): void {
    this.buffer = ''
    this.symbology = 0
    this.expected = 0
  }

  get pending(): boolean {
    return this.buffer.length > 0
  }
}

const decoder = new TextDecoder('utf-8', { fatal: false })

function decode(bytes: Uint8Array): string {
  // Trailing NULs are padding, not data. Left in, they would be submitted as
  // part of the barcode and never match anything.
  let end = bytes.length
  while (end > 0 && bytes[end - 1] === 0) end--

  return decoder.decode(bytes.subarray(0, end))
}

/**
 * Builds a scanned-data report. For tests, and for the simulator.
 *
 * Exported so the synthetic reports the parser is tested against are built from
 * the same description of the layout that the parser reads — if the layout is
 * wrong, it is wrong in one place rather than two agreeing with each other.
 * The GS1 vector in the tests is what guards against that.
 */
export function buildScannedDataReport(
  data: string,
  symbology: number,
  options: { reportSize?: number; includeReportId?: boolean } = {},
): Uint8Array {
  const bytes = new TextEncoder().encode(data)
  const prefix = options.includeReportId ? 1 : 0
  const size = options.reportSize ?? HEADER_BYTES + bytes.length

  const report = new Uint8Array(prefix + size)
  if (options.includeReportId) report[0] = SCANNED_DATA_REPORT_ID

  report[prefix] = 0
  report[prefix + 1] = bytes.length & 0xff
  report[prefix + 2] = (bytes.length >> 8) & 0xff
  report[prefix + 3] = symbology
  report.set(bytes.subarray(0, size - HEADER_BYTES), prefix + HEADER_BYTES)

  return report
}

/** The symbology codes, for building test vectors and the simulator. */
export const Symbology = {
  CODE128: 0x0c,
  EAN13: 0x10,
  UPCA: 0x12,
  GS1_128: 0x14,
  QR: 0x16,
  DATAMATRIX: 0x17,
  PDF417: 0x18,
} as const
