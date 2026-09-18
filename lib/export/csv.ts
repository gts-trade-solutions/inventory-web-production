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

/**
 * The same file, produced a row at a time.
 *
 * A year of movements is not a string worth holding in memory twice — once as
 * rows and once as the joined text. This yields each line as it is produced, so
 * memory stays flat whether the export is ten rows or a hundred thousand, and
 * the browser starts receiving the file immediately rather than after the whole
 * query has been formatted.
 */
export function csvStream<T>(
  rows: AsyncIterable<T> | readonly T[],
  columns: ReadonlyArray<CsvColumn<T>>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()

  const iterator = (
    Symbol.asyncIterator in rows
      ? (rows as AsyncIterable<T>)
      : (async function* () {
          for (const row of rows as readonly T[]) yield row
        })()
  )[Symbol.asyncIterator]()

  let wroteHeader = false

  return new ReadableStream({
    async pull(controller) {
      if (!wroteHeader) {
        wroteHeader = true
        // The BOM goes out with the header, for the same reason as below.
        const header = columns.map((column) => escapeCsvValue(column.header)).join(',')
        controller.enqueue(encoder.encode(`${BOM}${header}`))
        return
      }

      const { done, value } = await iterator.next()
      if (done) {
        controller.close()
        return
      }

      const line = columns.map((column) => escapeCsvValue(column.value(value))).join(',')
      controller.enqueue(encoder.encode(`\r\n${line}`))
    },

    async cancel() {
      // A browser that abandons the download should stop the query behind it
      // rather than leave it running to completion for nobody.
      await iterator.return?.()
    },
  })
}

/** A streamed downloadable response. */
export function csvStreamResponse(filename: string, body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
      'Cache-Control': 'no-store',
    },
  })
}

/** A filename that sorts chronologically and cannot collide by accident. */
export function reportFilename(name: string, at: Date = new Date(), extension = 'csv'): string {
  const stamp = at.toISOString().slice(0, 19).replace(/[:T]/g, '-')
  return `${name}-${stamp}.${extension}`
}
