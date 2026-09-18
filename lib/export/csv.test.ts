import { describe, expect, it } from 'vitest'
import { escapeCsvValue, reportFilename, toCsv } from './csv'
import { parseCsv } from '@/lib/import/csv'

/**
 * Writing CSV.
 *
 * The property that matters most is the round trip: anything this writes must
 * come back through the parser unchanged. A report that cannot be read back is
 * a report that cannot be checked.
 */

describe('escaping', () => {
  it('leaves an ordinary value alone', () => {
    expect(escapeCsvValue('TLS-0021')).toBe('TLS-0021')
  })

  it('quotes a value containing a comma', () => {
    // The failure this prevents: the field splits in two and every column after
    // it shifts, silently.
    expect(escapeCsvValue('Bracket, 90 degree')).toBe('"Bracket, 90 degree"')
  })

  it('doubles an inner quote', () => {
    expect(escapeCsvValue('He said "hello"')).toBe('"He said ""hello"""')
  })

  it('quotes a value containing a newline', () => {
    expect(escapeCsvValue('one\ntwo')).toBe('"one\ntwo"')
  })

  it('writes nothing for null and undefined', () => {
    expect(escapeCsvValue(null)).toBe('')
    expect(escapeCsvValue(undefined)).toBe('')
  })

  it('writes a date in a form that sorts', () => {
    expect(escapeCsvValue(new Date('2026-09-18T10:00:00.000Z'))).toBe('2026-09-18T10:00:00.000Z')
  })

  it('writes a boolean as a word, not true/false', () => {
    // The reader is a person, and a spreadsheet column of TRUE/FALSE is harder
    // to scan than yes/no.
    expect(escapeCsvValue(true)).toBe('yes')
    expect(escapeCsvValue(false)).toBe('no')
  })

  it('stops Excel executing a value as a formula', () => {
    // A value starting with = + - or @ is run as a formula on open. A SKU like
    // -A100 is not a formula, and a crafted one is a real attack on whoever
    // opens the file.
    expect(escapeCsvValue('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)")
    expect(escapeCsvValue('-A100')).toBe("'-A100")
    expect(escapeCsvValue('+1234')).toBe("'+1234")
    expect(escapeCsvValue('@cmd')).toBe("'@cmd")
  })
})

describe('toCsv', () => {
  const rows = [
    { sku: 'TLS-0021', name: 'Cordless drill', quantity: 12 },
    { sku: 'BRK-1', name: 'Bracket, 90 degree', quantity: 0 },
  ]
  const columns = [
    { header: 'sku', value: (row: (typeof rows)[number]) => row.sku },
    { header: 'name', value: (row: (typeof rows)[number]) => row.name },
    { header: 'quantity', value: (row: (typeof rows)[number]) => row.quantity },
  ]

  it('writes a header row and one line per record', () => {
    const csv = toCsv(rows, columns)

    expect(csv.split('\r\n')).toHaveLength(3)
    expect(csv.startsWith('sku,name,quantity')).toBe(true)
  })

  it('uses CRLF, which is what Excel expects', () => {
    expect(toCsv(rows, columns)).toContain('\r\n')
  })

  it('round-trips back through the parser', () => {
    // The whole point: a report that cannot be read back cannot be checked.
    const parsed = parseCsv(toCsv(rows, columns))

    expect(parsed.rows).toHaveLength(2)
    expect(parsed.rows[1]?.values).toEqual({
      sku: 'BRK-1',
      name: 'Bracket, 90 degree',
      quantity: '0',
    })
  })

  it('writes just the header for an empty result', () => {
    // An empty file would look like a failed export; a header row says "we
    // looked, and there was nothing".
    expect(toCsv([], columns)).toBe('sku,name,quantity')
  })
})

describe('reportFilename', () => {
  it('sorts chronologically and carries no colons', () => {
    // Colons are not legal in a Windows filename, and a download that silently
    // fails to save is worse than one that is awkwardly named.
    const name = reportFilename('recall', new Date('2026-09-18T10:31:04.512Z'))

    expect(name).toBe('recall-2026-09-18-10-31-04.csv')
    expect(name).not.toContain(':')
  })
})
