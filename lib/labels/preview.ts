import { ean13Bars, ean13Groups, Ean13Error } from './ean13-bars'

/**
 * Turns ZPL into something a browser can draw.
 *
 * The preview is parsed from the SAME bytes that go to the printer, so what is
 * on screen is what was sent. A preview built from the template and the field
 * values separately would be a drawing of what we hope will print, and would
 * stay convincing after the rendering broke.
 *
 * It understands the subset of ZPL our templates use. Anything else is reported
 * as unsupported rather than ignored, because a preview that silently omits a
 * command is worse than one that admits it: the operator would approve a layout
 * that is not the layout.
 *
 * Pure, and free of server-only imports, so the client component can use it.
 */

export interface TextElement {
  kind: 'TEXT'
  x: number
  y: number
  height: number
  text: string
  /** Wrap width in dots, from ^FB. */
  blockWidth?: number
}

export interface BarcodeElement {
  kind: 'BARCODE'
  x: number
  y: number
  height: number
  /** Module width in dots, from ^BY. */
  moduleWidth: number
  data: string
  symbology: 'EAN13' | 'CODE128'
  /** Bar pattern, when we can compute it faithfully. */
  bars: string | null
  /** Digits as printed under an EAN-13. */
  groups: [string, string, string] | null
  showText: boolean
  /** Why the bars could not be drawn, when they could not. */
  note: string | null
}

export type LabelElement = TextElement | BarcodeElement

export interface LabelPreview {
  /** Label size in dots, from ^PW and ^LL. Null when the ZPL does not say. */
  widthDots: number | null
  heightDots: number | null
  elements: LabelElement[]
  /** Commands we did not draw. Shown to the operator, never swallowed. */
  unsupported: string[]
  /** EPC this format encodes, from ^RFW. */
  epc: string | null
  copies: number
}

/** One preview per ^XA … ^XZ format. */
export function previewZpl(zpl: string): LabelPreview[] {
  return zpl
    .split('^XA')
    .slice(1)
    .map((format) => previewFormat(format.split('^XZ')[0] ?? ''))
}

function previewFormat(body: string): LabelPreview {
  const preview: LabelPreview = {
    widthDots: null,
    heightDots: null,
    elements: [],
    unsupported: [],
    epc: null,
    copies: 1,
  }

  // Pending state accumulates until a ^FD closes it, which is how ZPL works:
  // ^FO sets where the NEXT field goes.
  let x = 0
  let y = 0
  let fontHeight = 30
  let blockWidth: number | undefined
  let moduleWidth = 2
  let barcodeHeight = 100
  let pendingBarcode: { symbology: 'EAN13' | 'CODE128'; showText: boolean } | null = null
  let pendingRfid = false

  for (const command of body.split('^').map((part) => part.trim()).filter(Boolean)) {
    const verb = command.slice(0, 2).toUpperCase()
    const rest = command.slice(2)

    switch (verb) {
      case 'PW':
        preview.widthDots = toInt(rest) ?? preview.widthDots
        break
      case 'LL':
        preview.heightDots = toInt(rest) ?? preview.heightDots
        break
      case 'CI': // Encoding. Affects bytes, not layout.
        break
      case 'FO': {
        const [left, top] = rest.split(',')
        x = toInt(left) ?? 0
        y = toInt(top) ?? 0
        break
      }
      case 'A0': {
        // ^A0N,height,width
        const parts = rest.split(',')
        fontHeight = toInt(parts[1]) ?? fontHeight
        break
      }
      case 'CF': {
        // ^CF0,height — sets the default font for what follows.
        const parts = rest.split(',')
        fontHeight = toInt(parts[1]) ?? fontHeight
        break
      }
      case 'FB': {
        blockWidth = toInt(rest.split(',')[0]) ?? undefined
        break
      }
      case 'BY': {
        const parts = rest.split(',')
        moduleWidth = toInt(parts[0]) ?? moduleWidth
        barcodeHeight = toInt(parts[2]) ?? barcodeHeight
        break
      }
      case 'BE': {
        // ^BEN,height,printInterpretationLine,...
        const parts = rest.split(',')
        barcodeHeight = toInt(parts[1]) ?? barcodeHeight
        pendingBarcode = { symbology: 'EAN13', showText: (parts[2] ?? 'Y').toUpperCase() !== 'N' }
        break
      }
      case 'BC': {
        const parts = rest.split(',')
        barcodeHeight = toInt(parts[1]) ?? barcodeHeight
        pendingBarcode = { symbology: 'CODE128', showText: (parts[2] ?? 'Y').toUpperCase() !== 'N' }
        break
      }
      case 'RS': // RFID setup; the write follows in ^RFW.
        break
      case 'RF': {
        // ^RFW,H — the next ^FD is tag data, not printed text.
        if (rest.toUpperCase().startsWith('W')) pendingRfid = true
        break
      }
      case 'FD': {
        const data = rest

        if (pendingRfid) {
          preview.epc = data.toUpperCase()
          pendingRfid = false
          break
        }

        if (pendingBarcode) {
          preview.elements.push(barcodeElement(data, x, y, barcodeHeight, moduleWidth, pendingBarcode))
          pendingBarcode = null
        } else {
          preview.elements.push({ kind: 'TEXT', x, y, height: fontHeight, text: data, blockWidth })
        }

        blockWidth = undefined
        break
      }
      case 'FS': // Field separator: the field above is complete.
        break
      case 'PQ':
        preview.copies = toInt(rest) ?? 1
        break
      default:
        // Named rather than dropped. An operator approving a layout should know
        // the preview did not draw everything.
        if (verb) preview.unsupported.push(`^${verb}`)
    }
  }

  return preview
}

function barcodeElement(
  data: string,
  x: number,
  y: number,
  height: number,
  moduleWidth: number,
  pending: { symbology: 'EAN13' | 'CODE128'; showText: boolean },
): BarcodeElement {
  const base: BarcodeElement = {
    kind: 'BARCODE',
    x,
    y,
    height,
    moduleWidth,
    data,
    symbology: pending.symbology,
    bars: null,
    groups: null,
    showText: pending.showText,
    note: null,
  }

  if (pending.symbology !== 'EAN13') {
    // Code 128 encodes through shifting character sets; drawing an approximation
    // would look right and scan as nothing. Saying so is more honest than a
    // picture of a barcode.
    return { ...base, note: 'Code 128 bars are not drawn here. The printer encodes them.' }
  }

  try {
    return { ...base, bars: ean13Bars(data), groups: ean13Groups(data) }
  } catch (error) {
    return {
      ...base,
      note: error instanceof Ean13Error ? error.message : 'This barcode could not be encoded.',
    }
  }
}

function toInt(value: string | undefined): number | null {
  if (value === undefined) return null
  const parsed = Number.parseInt(value.trim(), 10)
  return Number.isFinite(parsed) ? parsed : null
}
