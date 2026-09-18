'use server'

import { z } from 'zod'
import { requireUser } from '@/lib/auth/guards'
import { buildRecallPack, type RecallLine } from '@/lib/services/recall'
import { toCsv } from '@/lib/export/csv'

/**
 * Building a recall pack from the batch screen.
 *
 * Open to any signed-in user. During an incident the person who needs it is
 * whoever is holding the phone, and making them find a supervisor first is how
 * a recall takes a day instead of an hour.
 */

export interface RecallPackState {
  error?: string
  summary?: {
    onHand: number
    movements: number
    issuedUnits: number
    received: number
    issued: number
    scrapped: number
    expectedOnHand: number
    balanced: boolean
  }
  /** The whole sheet, so the download is exactly what was reviewed. */
  csv?: string
}

export async function recallPackAction(batchId: string): Promise<RecallPackState> {
  const user = await requireUser()

  if (!z.string().uuid().safeParse(batchId).success) {
    return { error: 'That batch could not be identified.' }
  }

  try {
    const pack = await buildRecallPack(user.db, batchId)

    const body = toCsv<RecallLine>(pack.lines, [
      { header: 'section', value: (line) => line.section },
      { header: 'reference', value: (line) => line.reference },
      { header: 'detail', value: (line) => line.detail },
      { header: 'quantity', value: (line) => line.quantity },
      { header: 'when', value: (line) => line.at },
      { header: 'who', value: (line) => line.who },
    ])

    // The heading travels with the file. A sheet that arrives by email with no
    // batch number on it is a sheet nobody can act on.
    const heading = [
      `Recall pack for batch ${pack.batch.batchNo} (${pack.batch.itemSku} ${pack.batch.itemName})`,
      `Generated ${pack.generatedAt.toISOString()}`,
      pack.reconciliation.balanced
        ? 'The ledger balances against stock on hand.'
        : 'WARNING: the ledger does not balance against stock on hand. See the RECONCILIATION line.',
      '',
    ].join('\r\n')

    return {
      summary: {
        onHand: pack.onHand,
        movements: pack.movements.length,
        issuedUnits: pack.issued.length,
        received: pack.reconciliation.received,
        issued: pack.reconciliation.issued,
        scrapped: pack.reconciliation.scrapped,
        expectedOnHand: pack.reconciliation.expectedOnHand,
        balanced: pack.reconciliation.balanced,
      },
      csv: heading + body,
    }
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'That recall pack could not be built.',
    }
  }
}
