/**
 * CSV parsing.
 *
 * Written rather than pulled in, because the awkward parts are few and the
 * behaviour matters: a spreadsheet exported from Excel on a Windows machine
 * arrives with a BOM, CRLF line endings, quoted fields containing commas, and
 * doubled quotes inside them. Getting any of those wrong corrupts an import
 * silently — a product called `Bracket, 90°` becomes two columns and every
 * field after it shifts.
 *
 * Pure, so every one of those cases is tested directly.
 */

export class CsvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CsvError'
  }
}

export interface CsvRow {
  /** 1-based, counting the header, so it matches what the spreadsheet shows. */
  line: number
  values: Record<string, string>
}

export interface ParsedCsv {
  headers: string[]
  rows: CsvRow[]
}

const BOM = '﻿'

/**
 * Splits CSV text into records.
 *
 * Handles quoted fields, embedded commas and newlines, doubled quotes, CRLF,
 * and a leading byte-order mark.
 */
export function parseCsv(text: string): ParsedCsv {
  const source = text.startsWith(BOM) ? text.slice(BOM.length) : text
  const records = splitRecords(source)

  if (records.length === 0) throw new CsvError('That file is empty.')

  const headers = records[0]!.fields.map((header) => header.trim())
  if (headers.every((header) => header === '')) {
    throw new CsvError('That file has no column headings in its first row.')
  }

  const duplicates = headers.filter(
    (header, index) => header !== '' && headers.indexOf(header) !== index,
  )
  if (duplicates.length > 0) {
    // Two columns with one name means one silently wins, and which one is an
    // implementation detail nobody should have to know.
    throw new CsvError(`Two columns are both called "${duplicates[0]}". Rename one of them.`)
  }

  const rows: CsvRow[] = []

  for (const record of records.slice(1)) {
    // A trailing newline produces one empty record; so does a blank line in the
    // middle, and neither is a row somebody meant to import.
    if (record.fields.every((field) => field.trim() === '')) continue

    const values: Record<string, string> = {}
    headers.forEach((header, index) => {
      if (header !== '') values[header] = (record.fields[index] ?? '').trim()
    })

    rows.push({ line: record.line, values })
  }

  return { headers, rows }
}

interface Record_ {
  line: number
  fields: string[]
}

function splitRecords(source: string): Record_[] {
  const records: Record_[] = []

  let fields: string[] = []
  let field = ''
  let quoted = false
  let line = 1
  let recordStartLine = 1

  const endField = () => {
    fields.push(field)
    field = ''
  }

  const endRecord = () => {
    endField()
    records.push({ line: recordStartLine, fields })
    fields = []
    recordStartLine = line
  }

  for (let i = 0; i < source.length; i++) {
    const char = source[i]!

    if (quoted) {
      if (char === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (source[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        if (char === '\n') line++
        field += char
      }
      continue
    }

    if (char === '"' && field === '') {
      quoted = true
      continue
    }

    if (char === ',') {
      endField()
      continue
    }

    if (char === '\r') {
      // CRLF. A lone CR is treated as a line ending too, which is what an old
      // Mac export produces.
      if (source[i + 1] === '\n') i++
      line++
      endRecord()
      continue
    }

    if (char === '\n') {
      line++
      endRecord()
      continue
    }

    field += char
  }

  if (quoted) {
    throw new CsvError('A quoted value is never closed. Check for a stray " in the file.')
  }

  // Anything left is the final record, when the file has no trailing newline.
  if (field !== '' || fields.length > 0) endRecord()

  return records
}

/**
 * Checks the columns an import needs are present.
 *
 * Reported before any row is looked at: telling somebody row 412 is missing a
 * SKU when the column is called "Item Code" wastes their afternoon.
 */
export function requireColumns(parsed: ParsedCsv, required: readonly string[]): void {
  const missing = required.filter((column) => !parsed.headers.includes(column))

  if (missing.length > 0) {
    throw new CsvError(
      `That file is missing ${missing.map((column) => `"${column}"`).join(', ')}. It has ${parsed.headers
        .map((header) => `"${header}"`)
        .join(', ')}.`,
    )
  }
}
