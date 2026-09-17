import 'server-only'
import type { PrismaClient } from '@prisma/client'
import type { Db } from '@/lib/db'

/**
 * Rebuilding and verifying the stock projection.
 *
 * `stock_levels` is a cache of the ledger, maintained transactionally on every
 * write. A cache can drift — through a bug, a manual SQL edit, a partial restore
 * — and stock numbers that drifted silently are the worst failure this system
 * has, because nobody finds out until a count disagrees with reality.
 *
 * So the projection is recomputable from the ledger at any time, and the nightly
 * job compares the two. That comparison is the real reason the ledger is
 * append-only: it means the truth is always still there to check against
 * (ARCHITECTURE §4.3, WADR-002).
 */

export interface DriftRow {
  itemId: string
  locationId: string
  batchId: string
  projected: number
  fromLedger: number
}

/**
 * Recomputes every `stock_levels` row from `movements`, in one transaction.
 *
 * Deletes and reinserts rather than updating in place, so a row that should no
 * longer exist actually disappears. Rows that net to zero are dropped, matching
 * `projectStock` in the domain.
 */
export async function rebuildProjections(prisma: PrismaClient): Promise<{ rows: number }> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('DELETE FROM stock_levels')

      await tx.$executeRawUnsafe(`
        INSERT INTO stock_levels (itemId, locationId, batchId, quantity, updatedAt)
        SELECT itemId, locationId, batchId, SUM(delta) AS quantity, NOW(3)
          FROM (
                SELECT itemId, toLocationId   AS locationId,
                       COALESCE(batchId, '${NO_BATCH_SQL}') AS batchId,
                       quantity               AS delta
                  FROM movements
                 WHERE toLocationId IS NOT NULL
                 UNION ALL
                SELECT itemId, fromLocationId AS locationId,
                       COALESCE(batchId, '${NO_BATCH_SQL}') AS batchId,
                       -quantity              AS delta
                  FROM movements
                 WHERE fromLocationId IS NOT NULL
               ) AS ledger
         GROUP BY itemId, locationId, batchId
        HAVING SUM(delta) <> 0
      `)

      const [row] = await tx.$queryRawUnsafe<Array<{ n: bigint }>>(
        'SELECT COUNT(*) AS n FROM stock_levels',
      )

      // Serial units carry their own location, projected the same way: whichever
      // movement most recently moved each unit decides where it is.
      await rebuildSerialLocations(tx)

      return { rows: Number(row?.n ?? 0) }
    },
    { timeout: 120_000 },
  )
}

/**
 * Compares the stored projection against the ledger without changing anything.
 *
 * An empty result is the assertion worth having: it says every stock number in
 * the system is explained by a movement somebody can point at.
 */
export async function findProjectionDrift(prisma: PrismaClient): Promise<DriftRow[]> {
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      itemId: string
      locationId: string
      batchId: string
      projected: number | null
      fromLedger: number | null
    }>
  >(`
    SELECT COALESCE(s.itemId, l.itemId)         AS itemId,
           COALESCE(s.locationId, l.locationId) AS locationId,
           COALESCE(s.batchId, l.batchId)       AS batchId,
           s.quantity                           AS projected,
           l.quantity                           AS fromLedger
      FROM stock_levels s
      LEFT JOIN (${LEDGER_TOTALS_SQL}) l
        ON l.itemId = s.itemId AND l.locationId = s.locationId AND l.batchId = s.batchId
     WHERE s.quantity <> COALESCE(l.quantity, 0)

     UNION ALL

    -- Rows the ledger says should exist but the projection has lost entirely.
    SELECT l.itemId, l.locationId, l.batchId, NULL, l.quantity
      FROM (${LEDGER_TOTALS_SQL}) l
      LEFT JOIN stock_levels s
        ON s.itemId = l.itemId AND s.locationId = l.locationId AND s.batchId = l.batchId
     WHERE s.itemId IS NULL
  `)

  return rows.map((row) => ({
    itemId: row.itemId,
    locationId: row.locationId,
    batchId: row.batchId,
    projected: Number(row.projected ?? 0),
    fromLedger: Number(row.fromLedger ?? 0),
  }))
}

/** Recomputes where each serial unit is from the movements that carried it. */
async function rebuildSerialLocations(tx: Db): Promise<void> {
  await tx.$executeRawUnsafe(`
    UPDATE serial_units u
      JOIN (
            SELECT ms.serialUnitId,
                   SUBSTRING_INDEX(
                     GROUP_CONCAT(
                       CONCAT_WS('|', COALESCE(m.toLocationId, ''), m.type)
                       ORDER BY m.recordedAt DESC, m.id DESC SEPARATOR '~~'
                     ), '~~', 1
                   ) AS latest
              FROM movement_serials ms
              JOIN movements m ON m.id = ms.movementId
             GROUP BY ms.serialUnitId
           ) AS last ON last.serialUnitId = u.id
       SET u.locationId = NULLIF(SUBSTRING_INDEX(last.latest, '|', 1), ''),
           u.status = CASE
                        WHEN SUBSTRING_INDEX(last.latest, '|', -1) = 'SCRAP' THEN 'SCRAPPED'
                        WHEN SUBSTRING_INDEX(last.latest, '|', 1) = ''       THEN 'ISSUED'
                        ELSE 'IN_STOCK'
                      END
  `)
}

const NO_BATCH_SQL = '00000000-0000-0000-0000-000000000000'

const LEDGER_TOTALS_SQL = `
  SELECT itemId, locationId, batchId, SUM(delta) AS quantity
    FROM (
          SELECT itemId, toLocationId   AS locationId,
                 COALESCE(batchId, '${NO_BATCH_SQL}') AS batchId,
                 quantity AS delta
            FROM movements WHERE toLocationId IS NOT NULL
           UNION ALL
          SELECT itemId, fromLocationId AS locationId,
                 COALESCE(batchId, '${NO_BATCH_SQL}') AS batchId,
                 -quantity AS delta
            FROM movements WHERE fromLocationId IS NOT NULL
         ) AS entries
   GROUP BY itemId, locationId, batchId
  HAVING SUM(delta) <> 0
`
