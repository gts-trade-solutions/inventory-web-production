import { describe, expect, it } from 'vitest'
import { CsvError, parseCsv, requireColumns } from './csv'

/**
 * CSV parsing.
 *
 * Every case here is one that corrupts an import SILENTLY if it is wrong. A
 * product called `Bracket, 90°` splitting into two columns shifts every field
 * after it, and the import succeeds — with the wrong data.
 */

describe('the ordinary case', () => {
  it('reads headers and rows', () => {
    const { headers, rows } = parseCsv('sku,name\nTLS-1,Drill\nTLS-2,Wrench')

    expect(headers).toEqual(['sku', 'name'])
    expect(rows).toHaveLength(2)
    expect(rows[0]?.values).toEqual({ sku: 'TLS-1', name: 'Drill' })
  })

  it('numbers rows the way a spreadsheet does', () => {
    // Somebody reading an error goes to that row in Excel. Counting from the
    // header is the only numbering that matches.
    const { rows } = parseCsv('sku\nA\nB')

    expect(rows[0]?.line).toBe(2)
    expect(rows[1]?.line).toBe(3)
  })

  it('trims surrounding whitespace', () => {
    expect(parseCsv('sku , name\n TLS-1 , Drill ').rows[0]?.values).toEqual({
      sku: 'TLS-1',
      name: 'Drill',
    })
  })
})

describe('what Excel actually produces', () => {
  it('strips a byte-order mark', () => {
    // Excel on Windows writes one, and without this the first column is called
    // "﻿sku" and never matches anything.
    const { headers } = parseCsv('﻿sku,name\nTLS-1,Drill')

    expect(headers[0]).toBe('sku')
  })

  it('reads CRLF line endings', () => {
    const { rows } = parseCsv('sku,name\r\nTLS-1,Drill\r\nTLS-2,Wrench\r\n')

    expect(rows).toHaveLength(2)
    expect(rows[1]?.values.name).toBe('Wrench')
  })

  it('reads a lone CR, as an old Mac export uses', () => {
    expect(parseCsv('sku\rA\rB').rows).toHaveLength(2)
  })

  it('keeps a comma inside a quoted field', () => {
    // The case that shifts every column after it.
    const { rows } = parseCsv('sku,name\nBRK-1,"Bracket, 90 degree"')

    expect(rows[0]?.values).toEqual({ sku: 'BRK-1', name: 'Bracket, 90 degree' })
  })

  it('reads a doubled quote as one literal quote', () => {
    const { rows } = parseCsv('sku,name\nA,"He said ""hello"""')

    expect(rows[0]?.values.name).toBe('He said "hello"')
  })

  it('keeps a newline inside a quoted field', () => {
    const { rows } = parseCsv('sku,note\nA,"first line\nsecond line"')

    expect(rows).toHaveLength(1)
    expect(rows[0]?.values.note).toBe('first line\nsecond line')
  })

  it('counts the row after a multi-line field correctly', () => {
    // Otherwise every error after a wrapped cell points at the wrong row.
    const { rows } = parseCsv('sku,note\nA,"one\ntwo"\nB,plain')

    expect(rows[1]?.values.sku).toBe('B')
    expect(rows[1]?.line).toBe(4)
  })

  it('handles a file with no trailing newline', () => {
    expect(parseCsv('sku\nA').rows).toHaveLength(1)
  })

  it('ignores blank lines', () => {
    expect(parseCsv('sku\nA\n\n\nB\n').rows).toHaveLength(2)
  })

  it('keeps an empty value rather than dropping the column', () => {
    const { rows } = parseCsv('sku,name\nA,')

    expect(rows[0]?.values).toEqual({ sku: 'A', name: '' })
  })

  it('tolerates a short row', () => {
    // A row with fewer cells than headers is common in hand-edited files.
    expect(parseCsv('a,b,c\n1,2').rows[0]?.values).toEqual({ a: '1', b: '2', c: '' })
  })
})

describe('what it refuses', () => {
  it('an empty file', () => {
    expect(() => parseCsv('')).toThrow(CsvError)
  })

  it('a file with no headings', () => {
    expect(() => parseCsv(',,\n1,2,3')).toThrow(/no column headings/)
  })

  it('two columns with the same name', () => {
    // One would silently win, and which one is an implementation detail nobody
    // should have to know.
    expect(() => parseCsv('sku,sku\nA,B')).toThrow(/Two columns are both called/)
  })

  it('an unclosed quote', () => {
    expect(() => parseCsv('sku\n"never closed')).toThrow(/never closed/)
  })
})

describe('requireColumns', () => {
  it('passes when everything is there', () => {
    expect(() => requireColumns(parseCsv('sku,name\nA,B'), ['sku', 'name'])).not.toThrow()
  })

  it('names what is missing and what was found', () => {
    // Telling somebody row 412 has no SKU when the column is called "Item Code"
    // wastes their afternoon.
    try {
      requireColumns(parseCsv('Item Code,name\nA,B'), ['sku'])
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as Error).message).toMatch(/"sku"/)
      expect((error as Error).message).toMatch(/"Item Code"/)
    }
  })

  it('allows extra columns', () => {
    // A file exported from another system carries columns we do not need, and
    // refusing it would mean asking somebody to edit a spreadsheet first.
    expect(() => requireColumns(parseCsv('sku,name,colour\nA,B,red'), ['sku'])).not.toThrow()
  })
})
