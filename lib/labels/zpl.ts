/**
 * ZPL rendering.
 *
 * Ported from the mobile app's `core/devices/printer/Zpl.kt`, with one change
 * that matters: the mobile MVP hard-codes label formats in Kotlin, so changing a
 * label needs an app release. Here the format is a row in `label_templates` and
 * this module only fills it in. Label formats change more often than software
 * does (DEVICE_INTEGRATION §6).
 *
 * Pure: no Prisma, no Next, no sockets. What comes out of here is exactly the
 * byte stream a printer receives, which is what makes it testable against a real
 * TCP double and against a ZPL renderer in CI.
 */

export class ZplError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZplError'
  }
}

/**
 * Field values a template can reference.
 *
 * Deliberately a flat map of strings rather than an item object: a template is
 * data that an administrator edits, and it should not be able to reach into the
 * shape of our domain model.
 */
export type LabelFields = Record<string, string | number | null | undefined>

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g

/**
 * `^` and `~` begin ZPL commands, so they cannot appear inside field data.
 *
 * An item named "Bracket ^ 90°" would otherwise turn the rest of the label into
 * commands — at best a corrupt label, at worst a printer left in a state the
 * next job inherits. Replaced with a space rather than dropped, so the text
 * keeps its shape.
 */
export function zplSafe(value: string): string {
  return value.replace(/[\^~]/g, ' ')
}

/**
 * Fills a template's placeholders.
 *
 * A placeholder with no value is an error rather than an empty string. A label
 * that silently prints a blank where the SKU should be is worse than one that
 * refuses to print: it looks right, gets stuck to a box, and is discovered weeks
 * later by somebody holding an unidentifiable carton.
 */
export function renderTemplate(zplBody: string, fields: LabelFields): string {
  const missing: string[] = []

  const rendered = zplBody.replace(PLACEHOLDER, (_match, name: string) => {
    const value = fields[name]
    if (value === null || value === undefined || value === '') {
      missing.push(name)
      return ''
    }
    return zplSafe(String(value))
  })

  if (missing.length > 0) {
    throw new ZplError(
      `This label needs ${missing.length === 1 ? 'a value' : 'values'} for ${[...new Set(missing)].join(', ')}.`,
    )
  }

  return rendered
}

/** The placeholders a template refers to, for validating it when it is saved. */
export function placeholdersIn(zplBody: string): string[] {
  return [...new Set(Array.from(zplBody.matchAll(PLACEHOLDER), (match) => match[1]!))]
}

const FORMAT_START = '^XA'
const PRINT_QUANTITY = /\^PQ(\d+)/

/**
 * How many labels a document actually prints.
 *
 * One per format (`^XA` … `^XZ`), times its `^PQ` quantity. Ported from
 * `Zpl.labelCount`. The count is what the operator is told and what the job
 * records, so it has to come from the ZPL rather than from what we meant to
 * send — a template carrying its own `^PQ2` prints twice whatever we intended.
 */
export function labelCount(zpl: string): number {
  return zpl
    .split(FORMAT_START)
    .slice(1)
    .reduce((total, format) => {
      const match = PRINT_QUANTITY.exec(format)
      const quantity = match ? Number.parseInt(match[1]!, 10) : 1
      return total + (Number.isFinite(quantity) && quantity > 0 ? quantity : 1)
    }, 0)
}

/** Whether the document is a complete, well-formed ZPL job. */
export function validateZpl(zpl: string): void {
  const starts = countOccurrences(zpl, FORMAT_START)
  const ends = countOccurrences(zpl, '^XZ')

  if (starts === 0) throw new ZplError('This label has no ^XA, so a printer would ignore it.')
  if (starts !== ends) {
    // An unterminated format leaves the printer waiting for the rest of a job
    // that never arrives, and the next job arrives into that state.
    throw new ZplError(
      `This label has ${starts} ^XA but ${ends} ^XZ. Every format must be closed, or the printer stalls waiting for the rest.`,
    )
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count++
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

// ---------------------------------------------------------------------------
// Copies and RFID encoding
// ---------------------------------------------------------------------------

export const MAX_COPIES = 99

/**
 * Sets the number of copies on a single-format document.
 *
 * `^PQ` is per format, so this refuses a multi-format document rather than
 * guessing which format the operator meant — printing 50 copies of the wrong
 * one wastes a roll of labels and the operator's afternoon.
 */
export function withCopies(zpl: string, copies: number): string {
  if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) {
    throw new ZplError(`Copies must be a whole number from 1 to ${MAX_COPIES}.`)
  }
  if (copies === 1) return zpl

  if (countOccurrences(zpl, FORMAT_START) !== 1) {
    throw new ZplError(
      'Copies can only be set on a label with a single format. This one has several, so say how many of each instead.',
    )
  }

  const existing = PRINT_QUANTITY.exec(zpl)
  if (existing) return zpl.replace(PRINT_QUANTITY, `^PQ${copies}`)

  return zpl.replace('^XZ', `^PQ${copies}\n^XZ`)
}

/**
 * Turns one label into `epcs.length` labels, each encoding its own tag.
 *
 * One format per EPC rather than `^PQ`: copies repeat the same tag data, so a
 * run of ten would produce ten tags with the same EPC — ten boxes the system
 * cannot tell apart, which is the exact failure serial allocation exists to
 * prevent (WADR-009).
 */
export function withRfidEncoding(zpl: string, epcs: readonly string[]): string {
  if (epcs.length === 0) throw new ZplError('At least one EPC is needed to encode a tag.')

  if (countOccurrences(zpl, FORMAT_START) !== 1) {
    throw new ZplError('RFID encoding needs a label with a single format.')
  }

  for (const epc of epcs) {
    if (!/^[0-9A-Fa-f]{24}$/.test(epc)) {
      throw new ZplError(`"${epc}" is not a 24-character EPC, so it cannot be written to a tag.`)
    }
  }

  return epcs
    .map((epc) =>
      // ^RS8 selects the EPC memory bank; ^RFW,H writes it as hex.
      zpl.replace('^XZ', `^RS8\n^RFW,H^FD${epc.toUpperCase()}^FS\n^XZ`),
    )
    .join('\n')
}

// ---------------------------------------------------------------------------
// The one label we generate rather than store
// ---------------------------------------------------------------------------

/**
 * The self-test label, printed during bring-up.
 *
 * Not a template row, because it has to work before anything is configured —
 * including on a printer whose templates have never been loaded. It exercises
 * text at two sizes and a Code 128 barcode, which is enough to tell a working
 * printer from one with a calibration or media problem.
 */
export function testLabel(printerLabel: string, simulated: boolean): string {
  const line = zplSafe(printerLabel) + (simulated ? ' (simulation)' : '')

  return [
    '^XA^CI28',
    '^CF0,36^FO40,40^FDInventory test label^FS',
    `^CF0,26^FO40,90^FD${line}^FS`,
    `^CF0,22^FO40,130^FD${new Date().toISOString()}^FS`,
    '^BY3^FO40,175^BCN,90,Y,N,N^FDTEST-0001^FS',
    '^XZ',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * A template's size in printer dots, for the preview and for `^PW` / `^LL`.
 *
 * Templates are stored in millimetres because that is what label stock is sold
 * in, but ZPL works in dots, and the conversion depends on the printer's dpi. A
 * 4-inch label is 812 dots on a 203 dpi printer and 1200 on a 300 dpi one —
 * which is why the same template on the wrong printer prints off the edge.
 */
export function dotsFor(widthMm: number, heightMm: number, dpi: number): {
  width: number
  height: number
} {
  if (dpi <= 0) throw new ZplError('A printer resolution must be a positive number of dots per inch.')

  const perMm = dpi / 25.4
  return {
    width: Math.round(widthMm * perMm),
    height: Math.round(heightMm * perMm),
  }
}
