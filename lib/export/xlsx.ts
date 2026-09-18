import { PassThrough, Readable } from 'node:stream'
import ExcelJS from 'exceljs'
import type { CsvColumn } from './csv'

/**
 * Writing XLSX (PROJECT_PLAN 8.4).
 *
 * The reason to offer this alongside CSV is not that people prefer Excel files.
 * It is that a CSV is a pile of strings, so Excel guesses what each one is — and
 * it guesses wrong in ways that quietly destroy data. `00123` becomes 123.
 * `1-2` becomes a date. A long barcode becomes `1.23457E+12` and cannot be
 * turned back. Here each cell carries its real type, so a number sorts as a
 * number, a date filters as a date, and a SKU stays exactly what it was.
 *
 * **Written to a stream, one row at a time.** A workbook built in memory has to
 * hold the whole sheet plus the zipped output before a single byte is sent, and
 * a year of movements is not a small sheet. The streaming writer flushes rows as
 * they are produced, so memory stays flat whether the export is ten rows or a
 * hundred thousand.
 */

/** Same shape as the CSV columns, so one definition feeds both formats. */
export type XlsxColumn<T> = CsvColumn<T> & {
  /** Approximate character width. Left to Excel's default when absent. */
  width?: number
}

export interface XlsxSheet<T> {
  name: string
  columns: ReadonlyArray<XlsxColumn<T>>
  rows: readonly T[] | AsyncIterable<T>
}

/** Excel's own date format, so the cell sorts and filters as a date. */
const DATE_FORMAT = 'yyyy-mm-dd hh:mm'

/**
 * Excel caps a sheet name at 31 characters and forbids a handful of them.
 *
 * Exceeding either makes the whole workbook refuse to open, which presents as a
 * corrupt-file dialog rather than anything that names the sheet.
 */
export function safeSheetName(name: string): string {
  const cleaned = name.replace(/[[\]:*?/\\]/g, ' ').trim()
  return (cleaned || 'Sheet').slice(0, 31)
}

/**
 * Streams one or more sheets as an XLSX file.
 *
 * Returns a web ReadableStream so a Route Handler can hand it straight to the
 * browser without buffering.
 */
export function xlsxStream<T>(sheets: ReadonlyArray<XlsxSheet<T>>): ReadableStream<Uint8Array> {
  const output = new PassThrough()

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: output,
    // Excel opens a workbook without these; some other readers refuse.
    useStyles: true,
    useSharedStrings: false,
  })

  // Deliberately not awaited: the caller needs the stream now, and the rows are
  // written into it as they are produced. Any failure is pushed into the stream
  // as an error, which surfaces as a broken download rather than a silent
  // truncation.
  void (async () => {
    try {
      for (const sheet of sheets) {
        // The frozen header is passed HERE, not assigned afterwards: on the
        // streaming writer `views` is a getter with no setter, and assigning to
        // it throws. The throw happens before a single byte is written, so the
        // download arrives as an empty file rather than an error — which looks
        // exactly like a report with no rows in it.
        const worksheet = workbook.addWorksheet(safeSheetName(sheet.name), {
          views: [{ state: 'frozen', ySplit: 1 }],
        })

        worksheet.columns = sheet.columns.map((column, index) => ({
          header: column.header,
          key: String(index),
          width: column.width ?? Math.max(12, Math.min(40, column.header.length + 4)),
        }))

        worksheet.getRow(1).font = { bold: true }

        for await (const row of toAsync(sheet.rows)) {
          const cells: Record<string, string | number | boolean | Date | null> = {}

          sheet.columns.forEach((column, index) => {
            const value = column.value(row)
            cells[String(index)] = value === undefined ? null : value
          })

          const added = worksheet.addRow(cells)

          // Format the date cells after the fact: exceljs needs the cell to
          // exist before its numFmt can be set.
          sheet.columns.forEach((column, index) => {
            if (column.value(row) instanceof Date) {
              added.getCell(index + 1).numFmt = DATE_FORMAT
            }
          })

          added.commit()
        }

        // Autofilter over the header, which is what makes a report usable
        // rather than merely present.
        if (sheet.columns.length > 0) {
          worksheet.autoFilter = {
            from: { row: 1, column: 1 },
            to: { row: 1, column: sheet.columns.length },
          }
        }

        worksheet.commit()
      }

      await workbook.commit()
    } catch (error) {
      output.destroy(error instanceof Error ? error : new Error(String(error)))
    }
  })()

  return Readable.toWeb(output) as ReadableStream<Uint8Array>
}

/** A downloadable XLSX response. */
export function xlsxResponse<T>(filename: string, sheets: ReadonlyArray<XlsxSheet<T>>): Response {
  return new Response(xlsxStream(sheets), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '')}"`,
      // A report is a snapshot of a moment; serving a cached one answers a
      // recall question with yesterday's data.
      'Cache-Control': 'no-store',
    },
  })
}

function toAsync<T>(rows: readonly T[] | AsyncIterable<T>): AsyncIterable<T> {
  if (Symbol.asyncIterator in rows) return rows as AsyncIterable<T>

  const array = rows as readonly T[]
  return (async function* () {
    for (const row of array) yield row
  })()
}
