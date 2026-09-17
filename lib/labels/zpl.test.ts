import { describe, expect, it } from 'vitest'
import {
  MAX_COPIES,
  ZplError,
  dotsFor,
  labelCount,
  placeholdersIn,
  renderTemplate,
  testLabel,
  validateZpl,
  withCopies,
  withRfidEncoding,
  zplSafe,
} from './zpl'

/**
 * What comes out of here is the exact byte stream a printer receives, so these
 * assert on the bytes rather than on a shape.
 */

const ITEM_LABEL = [
  '^XA^CI28^PW812^LL406',
  '^FO30,30^A0N,40,40^FB752,2,0,L^FD{{itemName}}^FS',
  '^FO30,125^A0N,28,28^FDSKU {{sku}}   LOC {{location}}^FS',
  '^FO30,175^BY3,2,150^BEN,150,Y,N^FD{{barcode12}}^FS',
  '^XZ',
].join('\n')

describe('zplSafe', () => {
  it('neutralises the two characters that start commands', () => {
    // "Bracket ^ 90°" would otherwise turn the rest of the label into commands.
    expect(zplSafe('Bracket ^ 90')).toBe('Bracket   90')
    expect(zplSafe('Tilde ~JA here')).toBe('Tilde  JA here')
  })

  it('keeps the text the same length, so layout does not shift', () => {
    expect(zplSafe('a^b~c')).toHaveLength(5)
  })

  it('leaves ordinary text alone', () => {
    expect(zplSafe('Cordless drill 18V')).toBe('Cordless drill 18V')
  })
})

describe('renderTemplate', () => {
  it('fills every placeholder', () => {
    const zpl = renderTemplate(ITEM_LABEL, {
      itemName: 'Cordless drill',
      sku: 'TLS-0015',
      location: 'A-01',
      barcode12: '890123400004',
    })

    expect(zpl).toContain('^FDCordless drill^FS')
    expect(zpl).toContain('^FDSKU TLS-0015   LOC A-01^FS')
    expect(zpl).not.toContain('{{')
  })

  it('escapes the values it substitutes', () => {
    // The escape has to happen at substitution. An item name is data typed by a
    // person; the template around it is not.
    const zpl = renderTemplate('^XA^FD{{itemName}}^FS^XZ', { itemName: 'Angle ^FS^XZ bracket' })

    expect(zpl).toBe('^XA^FDAngle  FS XZ bracket^FS^XZ')
  })

  it('accepts numbers', () => {
    expect(renderTemplate('^XA^FD{{qty}}^FS^XZ', { qty: 12 })).toContain('^FD12^FS')
  })

  it('refuses to print a label with a missing value', () => {
    // A blank where the SKU should be looks right, gets stuck to a box, and is
    // found weeks later on an unidentifiable carton.
    expect(() => renderTemplate(ITEM_LABEL, { itemName: 'Drill', sku: 'TLS-0015' })).toThrow(
      ZplError,
    )
  })

  it('names every field it is missing, not just the first', () => {
    try {
      renderTemplate(ITEM_LABEL, { itemName: 'Drill' })
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as Error).message).toContain('sku')
      expect((error as Error).message).toContain('location')
      expect((error as Error).message).toContain('barcode12')
    }
  })

  it('treats an empty string as missing', () => {
    expect(() => renderTemplate('^XA^FD{{sku}}^FS^XZ', { sku: '' })).toThrow(/sku/)
  })

  it('tolerates whitespace inside the braces', () => {
    expect(renderTemplate('^XA^FD{{ sku }}^FS^XZ', { sku: 'A-1' })).toContain('^FDA-1^FS')
  })

  it('ignores a value the template does not ask for', () => {
    expect(renderTemplate('^XA^FD{{sku}}^FS^XZ', { sku: 'A', unused: 'B' })).not.toContain('B')
  })
})

describe('placeholdersIn', () => {
  it('lists the fields a template needs, once each', () => {
    expect(placeholdersIn(ITEM_LABEL)).toEqual(['itemName', 'sku', 'location', 'barcode12'])
    expect(placeholdersIn('^XA{{a}}{{a}}^XZ')).toEqual(['a'])
  })

  it('returns nothing for a template with no fields', () => {
    expect(placeholdersIn(testLabel('ZD621', false))).toEqual([])
  })
})

describe('labelCount', () => {
  // Ported from ZplTest.kt — the operator is told this number, and the job
  // records it.
  it('counts one per format', () => {
    expect(labelCount('^XA...^XZ')).toBe(1)
    expect(labelCount('^XA...^XZ\n^XA...^XZ')).toBe(2)
  })

  it('multiplies by the print quantity', () => {
    expect(labelCount('^XA...^PQ5^XZ')).toBe(5)
    expect(labelCount('^XA...^PQ3^XZ\n^XA...^PQ2^XZ')).toBe(5)
  })

  it('counts a template carrying its own ^PQ', () => {
    // What we meant to send is not what prints. A template with ^PQ2 doubles
    // whatever the operator asked for, and they should be told the real number.
    expect(labelCount('^XA^PQ2^XZ')).toBe(2)
  })

  it('is zero for something that is not a label', () => {
    expect(labelCount('')).toBe(0)
    expect(labelCount('hello')).toBe(0)
  })
})

describe('validateZpl', () => {
  it('accepts a complete document', () => {
    expect(() => validateZpl('^XA^FDx^FS^XZ')).not.toThrow()
    expect(() => validateZpl('^XA^XZ^XA^XZ')).not.toThrow()
  })

  it('refuses a document with no format', () => {
    expect(() => validateZpl('just some text')).toThrow(/\^XA/)
  })

  it('refuses an unterminated format', () => {
    // The printer waits for the rest of a job that never arrives, and the next
    // job arrives into that state.
    expect(() => validateZpl('^XA^FDx^FS')).toThrow(ZplError)
    expect(() => validateZpl('^XA^XZ^XA')).toThrow(/2 \^XA but 1 \^XZ/)
  })
})

describe('withCopies', () => {
  it('leaves a single copy untouched', () => {
    expect(withCopies('^XA^XZ', 1)).toBe('^XA^XZ')
  })

  it('adds ^PQ before the format ends', () => {
    expect(withCopies('^XA^FDx^FS^XZ', 4)).toBe('^XA^FDx^FS^PQ4\n^XZ')
  })

  it('replaces a quantity already present rather than adding a second', () => {
    const result = withCopies('^XA^PQ2^XZ', 7)

    expect(result).toBe('^XA^PQ7^XZ')
    expect(labelCount(result)).toBe(7)
  })

  it('refuses a multi-format document', () => {
    // ^PQ is per format. Guessing which one the operator meant wastes a roll of
    // labels and their afternoon.
    expect(() => withCopies('^XA^XZ^XA^XZ', 3)).toThrow(/single format/)
  })

  it('refuses a quantity a printer will not take', () => {
    expect(() => withCopies('^XA^XZ', 0)).toThrow(ZplError)
    expect(() => withCopies('^XA^XZ', MAX_COPIES + 1)).toThrow(ZplError)
    expect(() => withCopies('^XA^XZ', 2.5)).toThrow(ZplError)
  })
})

describe('withRfidEncoding', () => {
  const EPC_A = '30361F49C800004000000001'
  const EPC_B = '30361F49C800004000000002'

  it('writes the EPC into the tag', () => {
    const zpl = withRfidEncoding('^XA^FDx^FS^XZ', [EPC_A])

    expect(zpl).toContain('^RS8')
    expect(zpl).toContain(`^RFW,H^FD${EPC_A}^FS`)
  })

  it('produces one format per EPC, never copies', () => {
    // Copies repeat the same tag data, so a run of ten would encode ten tags
    // with the same EPC — ten boxes the system cannot tell apart (WADR-009).
    const zpl = withRfidEncoding('^XA^FDx^FS^XZ', [EPC_A, EPC_B])

    expect(labelCount(zpl)).toBe(2)
    expect(zpl).toContain(EPC_A)
    expect(zpl).toContain(EPC_B)
    expect(zpl).not.toContain('^PQ')
  })

  it('upper-cases the EPC', () => {
    expect(withRfidEncoding('^XA^XZ', [EPC_A.toLowerCase()])).toContain(EPC_A)
  })

  it('refuses anything that is not a 24-character EPC', () => {
    expect(() => withRfidEncoding('^XA^XZ', ['30361F49C8000040000000'])).toThrow(ZplError)
    expect(() => withRfidEncoding('^XA^XZ', ['NOTHEXNOTHEXNOTHEXNOTHEX'])).toThrow(ZplError)
  })

  it('refuses an empty list', () => {
    expect(() => withRfidEncoding('^XA^XZ', [])).toThrow(ZplError)
  })

  it('still produces valid ZPL', () => {
    expect(() => validateZpl(withRfidEncoding('^XA^FDx^FS^XZ', [EPC_A, EPC_B]))).not.toThrow()
  })
})

describe('testLabel', () => {
  it('is a complete, valid document on its own', () => {
    // It has to work before anything is configured, including on a printer whose
    // templates have never been loaded.
    const zpl = testLabel('ZD621R', false)

    expect(() => validateZpl(zpl)).not.toThrow()
    expect(labelCount(zpl)).toBe(1)
    expect(zpl).toContain('ZD621R')
  })

  it('says so when the printer is simulated', () => {
    expect(testLabel('Simulated printer', true)).toContain('(simulation)')
    expect(testLabel('ZD621R', false)).not.toContain('(simulation)')
  })

  it('escapes a printer label that contains ZPL characters', () => {
    expect(testLabel('Bay ^ 3', false)).not.toContain('Bay ^ 3')
  })
})

describe('dotsFor', () => {
  it('converts millimetres at the printer resolution', () => {
    // A 4 × 2 inch label: 812 × 406 dots at 203 dpi, matching the Kotlin format.
    expect(dotsFor(101.6, 50.8, 203)).toEqual({ width: 812, height: 406 })
  })

  it('gives a different size on a 300 dpi printer', () => {
    // The same template on the wrong printer prints off the edge, which is why
    // dpi belongs to the printer and not to the template.
    expect(dotsFor(101.6, 50.8, 300)).toEqual({ width: 1200, height: 600 })
  })

  it('refuses a resolution that cannot be real', () => {
    expect(() => dotsFor(100, 50, 0)).toThrow(ZplError)
    expect(() => dotsFor(100, 50, -203)).toThrow(ZplError)
  })
})
