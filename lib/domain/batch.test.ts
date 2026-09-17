import { describe, expect, it } from 'vitest'
import { resolveNewBatch } from './batch'
import { ADHESIVE, DRILL, NOW, TAPE } from './fixtures'

/**
 * Creating a batch as stock arrives.
 *
 * The expiry derivation matters more than it looks: an operator holding a carton
 * knows the manufacturing date printed on it and often not the expiry, and the
 * whole expiry system then depends on whatever lands in that field.
 */

describe('resolveNewBatch', () => {
  it('accepts a batch number and an explicit expiry', () => {
    const result = resolveNewBatch(
      ADHESIVE,
      { batchNo: ' LOT-9001 ', expiryDate: new Date('2027-01-31') },
      NOW,
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.batch.batchNo).toBe('LOT-9001')
      expect(result.batch.expiryDate).toEqual(new Date('2027-01-31'))
    }
  })

  it('derives the expiry from the manufacturing date and shelf life', () => {
    // ADHESIVE has a 365-day shelf life.
    const result = resolveNewBatch(ADHESIVE, {
      batchNo: 'LOT-9002',
      mfgDate: new Date('2026-01-01T00:00:00.000Z'),
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.batch.expiryDate?.toISOString().slice(0, 10)).toBe('2027-01-01')
    }
  })

  it('prefers an explicit expiry over the derived one', () => {
    // The label on the carton wins over our arithmetic.
    const result = resolveNewBatch(ADHESIVE, {
      batchNo: 'LOT-9003',
      mfgDate: new Date('2026-01-01T00:00:00.000Z'),
      expiryDate: new Date('2026-06-30T00:00:00.000Z'),
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.batch.expiryDate?.toISOString().slice(0, 10)).toBe('2026-06-30')
    }
  })

  it('requires an expiry when the item demands one and none can be derived', () => {
    const result = resolveNewBatch(ADHESIVE, { batchNo: 'LOT-9004' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('manufacturing date')
  })

  it('rejects a blank batch number', () => {
    expect(resolveNewBatch(ADHESIVE, { batchNo: '   ' }).ok).toBe(false)
  })

  it('rejects an expiry before the manufacturing date', () => {
    const result = resolveNewBatch(ADHESIVE, {
      batchNo: 'LOT-9005',
      mfgDate: new Date('2026-06-01'),
      expiryDate: new Date('2026-01-01'),
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain('before the manufacturing date')
  })

  it('accepts a batch that has already expired', () => {
    // It happens, and refusing to record it just means the stock sits on a shelf
    // the system cannot see. Issuing it is what gets blocked.
    const result = resolveNewBatch(
      ADHESIVE,
      { batchNo: 'LOT-OLD', expiryDate: new Date('2020-01-01') },
      NOW,
    )

    expect(result.ok).toBe(true)
  })

  it('refuses a batch on an item that is not batch-tracked', () => {
    expect(resolveNewBatch(TAPE, { batchNo: 'LOT-X' }).ok).toBe(false)
    expect(resolveNewBatch(DRILL, { batchNo: 'LOT-X' }).ok).toBe(false)
  })

  it('trims the supplier reference and drops an empty one', () => {
    const result = resolveNewBatch(ADHESIVE, {
      batchNo: 'LOT-9006',
      expiryDate: new Date('2027-01-01'),
      supplierRef: '   ',
    })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.batch.supplierRef).toBeNull()
  })
})
