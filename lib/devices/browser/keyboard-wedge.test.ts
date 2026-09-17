import { describe, expect, it } from 'vitest'
import { DEFAULT_WEDGE_OPTIONS, KeyboardWedge, type WedgeResult } from './keyboard-wedge'

/**
 * The scan-versus-typing heuristic.
 *
 * This decides whether keystrokes are a barcode or a person, and it runs on
 * every keypress in the app. Getting it wrong is either "scanning does nothing"
 * or "typing in the search box triggers random lookups", and both are the kind
 * of fault that is miserable to diagnose from a warehouse floor. So it is
 * exercised here against realistic and adversarial input rather than by waving a
 * scanner at a browser.
 */

/** Types a string at a fixed inter-character gap, optionally with a terminator. */
function type(
  wedge: KeyboardWedge,
  text: string,
  gapMs: number,
  terminator?: 'Enter' | 'Tab',
  startAt = 1000,
): WedgeResult[] {
  const results: WedgeResult[] = []
  let at = startAt

  for (const key of text) {
    results.push(wedge.accept({ key, at }))
    at += gapMs
  }

  if (terminator) results.push(wedge.accept({ key: terminator, at }))
  return results
}

const last = (results: WedgeResult[]) => results[results.length - 1]!

describe('recognising a scan', () => {
  it('accepts a barcode typed at scanner speed', () => {
    const wedge = new KeyboardWedge()

    // Zebra scanners emit at roughly 5-15 ms per character.
    const results = type(wedge, '8901234000045', 8, 'Enter')

    expect(last(results)).toEqual({ kind: 'SCAN', data: '8901234000045' })
  })

  it('accepts Tab as a terminator, since sites configure either', () => {
    const wedge = new KeyboardWedge()

    expect(last(type(wedge, '8901234000045', 8, 'Tab'))).toEqual({
      kind: 'SCAN',
      data: '8901234000045',
    })
  })

  it('handles a 24-character RFID EPC', () => {
    const wedge = new KeyboardWedge()

    expect(last(type(wedge, '30361F49C800054000018E70', 10, 'Enter'))).toEqual({
      kind: 'SCAN',
      data: '30361F49C800054000018E70',
    })
  })

  it('handles alphanumeric codes, not just digits', () => {
    const wedge = new KeyboardWedge()

    expect(last(type(wedge, 'TLS-0021-0001', 9, 'Enter'))).toEqual({
      kind: 'SCAN',
      data: 'TLS-0021-0001',
    })
  })

  it('suppresses keystrokes once the burst is long enough to be a barcode', () => {
    // Otherwise a scan into a search box types half the barcode, the field
    // reacts, and the terminator then replaces it.
    const wedge = new KeyboardWedge()
    const results = type(wedge, '8901234', 8)

    expect(results.slice(0, 3).every((r) => r.kind === 'PASS_THROUGH')).toBe(true)
    expect(results.slice(4).every((r) => r.kind === 'BUFFERING')).toBe(true)
  })

  it('scans back to back without bleeding into each other', () => {
    const wedge = new KeyboardWedge()

    const first = type(wedge, '8901234000045', 8, 'Enter', 1000)
    const second = type(wedge, '8901234000106', 8, 'Enter', 5000)

    expect(last(first)).toEqual({ kind: 'SCAN', data: '8901234000045' })
    expect(last(second)).toEqual({ kind: 'SCAN', data: '8901234000106' })
  })
})

describe('rejecting human typing', () => {
  it('ignores text typed at human speed', () => {
    const wedge = new KeyboardWedge()

    // ~120 ms per key is a brisk typist.
    const results = type(wedge, 'packing tape', 120, 'Enter')

    expect(results.every((r) => r.kind === 'PASS_THROUGH')).toBe(true)
  })

  it('ignores a fast typist who still is not a scanner', () => {
    const wedge = new KeyboardWedge()

    // 60 ms is about as fast as a person sustains.
    expect(type(wedge, 'adhesive', 60, 'Enter').every((r) => r.kind === 'PASS_THROUGH')).toBe(true)
  })

  it('lets a bare Enter through, so forms still submit', () => {
    const wedge = new KeyboardWedge()

    expect(wedge.accept({ key: 'Enter', at: 1000 })).toEqual({ kind: 'PASS_THROUGH' })
  })

  it('lets Enter through after a short entry, so "A1" submits normally', () => {
    const wedge = new KeyboardWedge()

    expect(last(type(wedge, 'A1', 10, 'Enter'))).toEqual({ kind: 'PASS_THROUGH' })
  })

  it('abandons the burst on any non-character key', () => {
    // Backspace, arrows and modifiers all mean a person is editing.
    const wedge = new KeyboardWedge()

    type(wedge, '890123', 8)
    expect(wedge.accept({ key: 'Backspace', at: 1100 })).toEqual({ kind: 'PASS_THROUGH' })
    expect(wedge.pending).toBe('')
  })

  it('does not lose the first character of a scan that follows typing', () => {
    // A pause then a burst is the normal case: the operator stops typing and
    // scans. The character that starts the burst must begin the new buffer, not
    // be discarded.
    const wedge = new KeyboardWedge()

    type(wedge, 'abc', 200)
    const results = type(wedge, '8901234000045', 8, 'Enter', 3000)

    expect(last(results)).toEqual({ kind: 'SCAN', data: '8901234000045' })
  })
})

describe('adversarial input', () => {
  it('discards a burst longer than any real barcode', () => {
    const wedge = new KeyboardWedge()

    const results = type(wedge, 'x'.repeat(DEFAULT_WEDGE_OPTIONS.maxLength + 10), 5, 'Enter')

    expect(last(results)).toEqual({ kind: 'PASS_THROUGH' })
  })

  it('treats a single slow character mid-burst as the start of a new one', () => {
    const wedge = new KeyboardWedge()

    wedge.accept({ key: '8', at: 1000 })
    wedge.accept({ key: '9', at: 1008 })
    // A 300 ms stall: a person, or a scanner that dropped the connection.
    wedge.accept({ key: '0', at: 1308 })

    expect(wedge.pending).toBe('0')
  })

  it('recovers after a reset mid-scan', () => {
    const wedge = new KeyboardWedge()

    type(wedge, '890123', 8)
    wedge.reset()

    expect(last(type(wedge, '8901234000045', 8, 'Enter', 3000))).toEqual({
      kind: 'SCAN',
      data: '8901234000045',
    })
  })

  it('accepts a barcode at exactly the timing boundary', () => {
    const wedge = new KeyboardWedge()

    expect(last(type(wedge, '8901234000045', DEFAULT_WEDGE_OPTIONS.maxGapMs, 'Enter'))).toEqual({
      kind: 'SCAN',
      data: '8901234000045',
    })
  })

  it('rejects one millisecond past the boundary', () => {
    const wedge = new KeyboardWedge()

    expect(last(type(wedge, '8901234000045', DEFAULT_WEDGE_OPTIONS.maxGapMs + 1, 'Enter'))).toEqual(
      { kind: 'PASS_THROUGH' },
    )
  })
})
