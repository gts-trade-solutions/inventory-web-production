import { apiRoute } from '@/lib/api/handler'
import { buildRecallPack } from '@/lib/services/recall'
import { csvResponse, reportFilename, toCsv } from '@/lib/export/csv'
import type { RecallLine } from '@/lib/services/recall'

/**
 * The recall pack for a batch.
 *
 * `?format=csv` returns a file, because a recall pack is passed to people who
 * do not have the system open — a quality manager, a customer, sometimes a
 * regulator.
 *
 * Available to any signed-in user. During an incident the person who needs it
 * is whoever is holding the phone, and making them find a supervisor first is
 * how a recall takes a day instead of an hour.
 */
export const GET = apiRoute({}, async ({ db, request }) => {
  const url = new URL(request.url)
  const batchId = url.pathname.split('/').pop()!

  const pack = await buildRecallPack(db, batchId)

  if (url.searchParams.get('format') !== 'csv') return pack

  const csv = toCsv<RecallLine>(pack.lines, [
    { header: 'section', value: (line) => line.section },
    { header: 'reference', value: (line) => line.reference },
    { header: 'detail', value: (line) => line.detail },
    { header: 'quantity', value: (line) => line.quantity },
    { header: 'when', value: (line) => line.at },
    { header: 'who', value: (line) => line.who },
  ])

  const header = [
    `Recall pack for batch ${pack.batch.batchNo} (${pack.batch.itemSku} ${pack.batch.itemName})`,
    `Generated ${pack.generatedAt.toISOString()}`,
    `On hand ${pack.onHand}. Received ${pack.reconciliation.received}, issued ${pack.reconciliation.issued}, scrapped ${pack.reconciliation.scrapped}.`,
    pack.reconciliation.balanced
      ? 'The ledger balances against stock on hand.'
      : 'WARNING: the ledger does not balance against stock on hand. See the RECONCILIATION line.',
    '',
  ].join('\r\n')

  return csvResponse(reportFilename(`recall-${pack.batch.batchNo}`), header + csv)
})
