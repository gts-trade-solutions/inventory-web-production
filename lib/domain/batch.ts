import { MovementErrorCode, type MovementError } from './movement'
import { TrackingMode, type Item } from './types'

/**
 * Creating a batch as stock arrives.
 *
 * A batch-tracked item cannot be received into a batch that does not exist yet,
 * and the batch does not exist until the stock does — so a receipt has to be
 * able to create one. That is why this is part of the receiving flow rather than
 * a separate "create batch" screen nobody would remember to visit first.
 *
 * Pure: it validates and computes, and the service writes the row.
 */

export interface NewBatchInput {
  batchNo: string
  mfgDate?: Date | null
  expiryDate?: Date | null
  supplierRef?: string | null
}

export interface ResolvedBatch {
  batchNo: string
  mfgDate: Date | null
  expiryDate: Date | null
  supplierRef: string | null
}

export type NewBatchDecision =
  { ok: true; batch: ResolvedBatch } | { ok: false; error: MovementError }

const DAY = 86_400_000

/**
 * Validates a batch being created on receipt, and derives its expiry where it
 * can.
 *
 * An operator holding a carton knows the manufacturing date printed on it and
 * often not the expiry, while the item's shelf life is already on record. Making
 * them do that arithmetic invites mistakes in a field the whole expiry system
 * then depends on.
 */
export function resolveNewBatch(
  item: Pick<Item, 'trackingMode' | 'expiryRequired' | 'shelfLifeDays'>,
  input: NewBatchInput,
  now: Date = new Date(),
): NewBatchDecision {
  if (item.trackingMode !== TrackingMode.BATCH) {
    return {
      ok: false,
      error: {
        code: MovementErrorCode.BATCH_REQUIRED,
        message: 'This item is not batch-tracked, so it cannot have a batch.',
      },
    }
  }

  const batchNo = input.batchNo.trim()
  if (!batchNo) {
    return {
      ok: false,
      error: { code: MovementErrorCode.BATCH_REQUIRED, message: 'Enter a batch or lot number.' },
    }
  }

  const mfgDate = input.mfgDate ?? null

  let expiryDate = input.expiryDate ?? null
  if (!expiryDate && mfgDate && item.shelfLifeDays) {
    expiryDate = new Date(mfgDate.getTime() + item.shelfLifeDays * DAY)
  }

  if (item.expiryRequired && !expiryDate) {
    return {
      ok: false,
      error: {
        code: MovementErrorCode.BATCH_REQUIRED,
        message: item.shelfLifeDays
          ? 'Enter an expiry date, or a manufacturing date to derive it from.'
          : 'This item needs an expiry date on every batch.',
      },
    }
  }

  if (expiryDate && mfgDate && expiryDate < mfgDate) {
    return {
      ok: false,
      error: {
        code: MovementErrorCode.BATCH_REQUIRED,
        message: 'The expiry date is before the manufacturing date.',
      },
    }
  }

  // Receiving already-expired stock is allowed — it happens, and refusing to
  // record it just means the stock sits on a shelf the system cannot see. It is
  // issuing it that is blocked (ARCHITECTURE §5.2). The expiry board will
  // surface it immediately.
  void now

  return {
    ok: true,
    batch: {
      batchNo,
      mfgDate,
      expiryDate,
      supplierRef: input.supplierRef?.trim() || null,
    },
  }
}
