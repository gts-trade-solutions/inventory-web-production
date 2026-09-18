/**
 * Writing CSV.
 *
 * The mirror of the parser, and it has to be: a file this produces must survive
 * a round trip back through `parseCsv`, and must open correctly in Excel on a
 * Windows machine — which is where these files actually go.
 *
 * Pure, so the escaping rules can be tested directly.
 */

const BOM = '﻿'

export interface CsvColumn<T> {
  header: string
  value: (row: T) => string | number | boolean | Date | null | undefined
}

/**
 * Escapes one value.
 *
 * Quoted whenever it contains a comma, a quote or a newline, with inner quotes
 * doubled. Without that, a product called `Bracket, 90°` splits into two
 * columns and every field after it shifts — the same failure as on the way in,
 * and just as silent.
 */
export function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return ''

  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'boolean'
        ? value
          ? 'yes'
          : 'no'
        : String(value)

  // A value starting with =, +, - or @ is executed as a formula by Excel. The
  // leading apostrophe makes it text, which is what a barcode or a SKU is.
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text

  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
}

export function toCsv<T>(rows: readonly T[], columns: ReadonlyArray<CsvColumn<T>>): string {
  const lines = [columns.map((column) => escapeCsvValue(column.header)).join(',')]

  for (const row of rows) {
    lines.push(columns.map((column) => escapeCsvValue(column.value(row))).join(','))
  }

  // CRLF, because that is what Excel expects and what every other tool accepts.
  return lines.join('\r\n')
}

/**
 * A downloadable response.
 *
 * The BOM is not decoration: without it Excel reads a UTF-8 file as the local
 * codepage, and every accented character in an item name arrives mangled.
 */
export function csvResponse(filename: string, body: string): Response {
  return new Response(BOM + body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
      // A report is a snapshot of a moment; serving a cached one silently
      // answers a recall question with yesterday's data.
      'Cache-Control': 'no-store',
    },
  })
}

/** A filename that sorts chronologically and cannot collide by accident. */
export function reportFilename(name: string, at = new Date()): string {
  const stamp = at.toISOString().slice(0, 19).replace(/[:T]/g, '-')
  return `${name}-${stamp}.csv`
}
