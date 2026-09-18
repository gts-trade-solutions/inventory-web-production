import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { safeSheetName, xlsxResponse, xlsxStream, type XlsxColumn } from './xlsx'

/**
 * Writing XLSX.
 *
 * Every test here reads the workbook BACK with a real reader. Asserting on what
 * the writer was told to do would pass just as happily if the file were
 * unopenable — and an export nobody can open is the whole failure mode worth
 * guarding against, because it is discovered by the person who needed the
 * figures, not by us.
 */

interface Row {
  sku: string
  name: string
  quantity: number
  received: Date | null
  active: boolean
}

const ROWS: Row[] = [
  {
    sku: '00123',
    name: 'Packing tape, 50mm',
    quantity: 250,
    received: new Date('2026-03-04T09:30:00.000Z'),
    active: true,
  },
  { sku: 'DRL-9', name: 'Drill bit', quantity: -3, received: null, active: false },
]

const COLUMNS: Array<XlsxColumn<Row>> = [
  { header: 'SKU', value: (row) => row.sku },
  { header: 'Item', value: (row) => row.name },
  { header: 'Quantity', value: (row) => row.quantity },
  { header: 'Received', value: (row) => row.received },
  { header: 'Active', value: (row) => row.active },
]

async function readBack(
  rows: readonly Row[] | AsyncIterable<Row>,
  name = 'Test',
): Promise<ExcelJS.Worksheet> {
  const stream = xlsxStream([{ name, columns: COLUMNS, rows }])

  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Buffer.concat(chunks) as unknown as ArrayBuffer)

  const sheet = workbook.worksheets[0]
  if (!sheet) throw new Error('the workbook came back with no sheets')

  return sheet
}

describe('the file it produces', () => {
  it('opens, and has the sheet it was asked for', async () => {
    const sheet = await readBack(ROWS, 'Stock on hand')

    expect(sheet.name).toBe('Stock on hand')
    // Header plus two rows.
    expect(sheet.rowCount).toBe(3)
  })

  it('writes the headers in the first row', async () => {
    const sheet = await readBack(ROWS)

    expect(sheet.getRow(1).values).toEqual([
      undefined,
      'SKU',
      'Item',
      'Quantity',
      'Received',
      'Active',
    ])
  })

  it('freezes the header row', async () => {
    // Not decoration: a report long enough to be worth exporting is long enough
    // that scrolling past the headers makes the columns unreadable.
    const sheet = await readBack(ROWS)

    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 })
  })
})

describe('cell types, which is the entire reason to offer XLSX', () => {
  it('keeps a quantity as a number', async () => {
    const sheet = await readBack(ROWS)

    expect(typeof sheet.getRow(2).getCell(3).value).toBe('number')
    expect(sheet.getRow(2).getCell(3).value).toBe(250)
  })

  it('keeps a negative quantity negative rather than as text', async () => {
    const sheet = await readBack(ROWS)

    expect(sheet.getRow(3).getCell(3).value).toBe(-3)
  })

  it('keeps a date as a date, with a date format', async () => {
    const sheet = await readBack(ROWS)
    const cell = sheet.getRow(2).getCell(4)

    expect(cell.value).toBeInstanceOf(Date)
    expect(cell.numFmt).toMatch(/yyyy/)
  })

  it('keeps a SKU with leading zeros intact', async () => {
    // The failure CSV cannot avoid: Excel reads 00123 as the number 123 and the
    // zeros are gone for good. Here it is a string cell and stays one.
    const sheet = await readBack(ROWS)

    expect(sheet.getRow(2).getCell(1).value).toBe('00123')
  })

  it('leaves a missing date empty rather than writing a placeholder', async () => {
    // An unknown received date must not become 1970, or the ageing column
    // sorts it to the top as the oldest stock in the building.
    const sheet = await readBack(ROWS)
    const cell = sheet.getRow(3).getCell(4)

    expect(cell.value).toBeNull()
  })

  it('writes a boolean as a boolean', async () => {
    const sheet = await readBack(ROWS)

    expect(sheet.getRow(2).getCell(5).value).toBe(true)
    expect(sheet.getRow(3).getCell(5).value).toBe(false)
  })
})

describe('streaming', () => {
  it('accepts rows that arrive one at a time', async () => {
    // The point of the streaming writer: a year of movements is produced and
    // flushed row by row rather than assembled in memory first.
    async function* slowly() {
      for (const row of ROWS) {
        await new Promise((resolve) => setTimeout(resolve, 1))
        yield row
      }
    }

    const sheet = await readBack(slowly())

    expect(sheet.rowCount).toBe(3)
    expect(sheet.getRow(2).getCell(1).value).toBe('00123')
  })

  it('fails the download rather than delivering an empty file', async () => {
    // The failure mode this guards against is specific and nasty. If the writer
    // throws before any bytes are flushed and the stream simply ENDS, the
    // browser saves a 0-byte file and the person who asked for the report gets
    // something that looks like "no stock matched" rather than an error. This
    // exact shape happened while building it: assigning to `views` on the
    // streaming writer throws, and the first version produced empty workbooks.
    const exploding: Array<XlsxColumn<Row>> = [
      {
        header: 'SKU',
        value: () => {
          throw new Error('the query died half way through')
        },
      },
    ]

    const stream = xlsxStream([{ name: 'Boom', columns: exploding, rows: ROWS }])
    const reader = stream.getReader()

    await expect(
      (async () => {
        for (;;) {
          const { done } = await reader.read()
          if (done) return
        }
      })(),
    ).rejects.toThrow(/died half way/)
  })

  it('produces a valid, openable file with no rows at all', async () => {
    // An empty report is a legitimate answer, and it must still open. A
    // zero-byte download looks identical to a failed one.
    const sheet = await readBack([])

    expect(sheet.rowCount).toBe(1)
    expect(sheet.getRow(1).getCell(1).value).toBe('SKU')
  })
})

describe('safeSheetName', () => {
  it('truncates to what Excel accepts', async () => {
    // Over 31 characters and the whole workbook refuses to open — presenting as
    // a corrupt-file dialog that names nothing.
    expect(safeSheetName('Stock on hand by item and location and batch').length).toBe(31)
  })

  it('removes the characters Excel forbids in a sheet name', () => {
    expect(safeSheetName('Stock: A/B [2026]')).not.toMatch(/[[\]:*?/\\]/)
  })

  it('never returns an empty name', () => {
    expect(safeSheetName('///')).toBe('Sheet')
  })

  it('produces a sheet Excel will actually open', async () => {
    const sheet = await readBack(ROWS, 'Counts: 2026/01 [draft] — a very long name indeed')

    expect(sheet.name.length).toBeLessThanOrEqual(31)
    expect(sheet.name).not.toMatch(/[[\]:*?/\\]/)
  })
})

describe('the response', () => {
  it('is typed and named so a browser saves it as a spreadsheet', async () => {
    const response = xlsxResponse('stock.xlsx', [{ name: 'S', columns: COLUMNS, rows: ROWS }])

    expect(response.headers.get('Content-Type')).toMatch(/spreadsheetml\.sheet/)
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="stock.xlsx"')
    // A report is a snapshot. A cached one answers a recall question with
    // yesterday's data.
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('strips quotes from the filename rather than breaking the header', async () => {
    const response = xlsxResponse('we"ird.xlsx', [{ name: 'S', columns: COLUMNS, rows: ROWS }])

    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="weird.xlsx"')
  })
})
