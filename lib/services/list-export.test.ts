import { describe, expect, it, vi } from 'vitest'
import { byId } from './list-export'

/**
 * Keyset paging for the list exports.
 *
 * Tested here rather than against the database because the risk is the loop,
 * not the query: an off-by-one in a keyset emits a row twice or drops it
 * entirely, and in a file of eighty thousand movements nobody will ever notice
 * which. The failure reaches an auditor, not a test.
 */

/** A fake table of `count` rows, paged exactly as the real query pages it. */
function table(count: number, pageSize: number) {
  const all = Array.from({ length: count }, (_, index) => ({
    id: String(index + 1).padStart(6, '0'),
  }))

  const fetchPage = vi.fn(async (after: string | null) => {
    const start = after === null ? 0 : all.findIndex((row) => row.id === after) + 1
    return all.slice(start, start + pageSize)
  })

  return { all, fetchPage }
}

async function collect<T>(rows: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const row of rows) out.push(row)
  return out
}

describe('byId', () => {
  it('yields every row once, in order', async () => {
    const { all, fetchPage } = table(25, 10)

    const rows = await collect(byId(fetchPage, 10))

    expect(rows.map((row) => row.id)).toEqual(all.map((row) => row.id))
  })

  it('yields nothing for an empty table', async () => {
    const { fetchPage } = table(0, 10)

    expect(await collect(byId(fetchPage, 10))).toEqual([])
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('handles a row count that is an exact multiple of the page size', async () => {
    // The off-by-one that matters. Twenty rows in pages of ten gives two full
    // pages; stopping on the second because it was full would be correct by
    // luck, and stopping only on a short page needs one more empty request —
    // which is what this asserts, because getting it wrong the other way drops
    // the final page of every export whose size happens to divide evenly.
    const { all, fetchPage } = table(20, 10)

    const rows = await collect(byId(fetchPage, 10))

    expect(rows).toHaveLength(20)
    expect(rows.map((row) => row.id)).toEqual(all.map((row) => row.id))
    // Two full pages, then one empty one to learn there is no more.
    expect(fetchPage).toHaveBeenCalledTimes(3)
  })

  it('stops after a short page without asking again', async () => {
    const { fetchPage } = table(15, 10)

    await collect(byId(fetchPage, 10))

    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('never yields the same row twice', async () => {
    const { fetchPage } = table(101, 10)

    const rows = await collect(byId(fetchPage, 10))

    expect(new Set(rows.map((row) => row.id)).size).toBe(101)
  })

  it('advances the cursor past the last row of each page', async () => {
    const { fetchPage } = table(25, 10)

    await collect(byId(fetchPage, 10))

    // null, then the last id of each page. A cursor taken from the FIRST row
    // would re-read the whole page every time and never terminate.
    expect(fetchPage.mock.calls.map((call) => call[0])).toEqual([null, '000010', '000020'])
  })

  it('stops reading when the consumer stops', async () => {
    // A browser that cancels a download should not leave the query running to
    // completion for nobody.
    const { fetchPage } = table(1000, 10)

    const rows = byId(fetchPage, 10)
    for await (const _row of rows) break

    expect(fetchPage).toHaveBeenCalledTimes(1)
  })
})
