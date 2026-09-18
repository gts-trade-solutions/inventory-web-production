import { randomUUID } from 'node:crypto'
import { MovementSource } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory,
} from '@/lib/services/categories'
import { createSite, listSites, updateSite } from '@/lib/services/sites'
import { listSequences, updateSequence } from '@/lib/services/sequences'
import { recordMovement } from '@/lib/services/movements'
import { prisma, seedWarehouse, type Warehouse } from './helpers/warehouse'

/**
 * Master data administration (7.4).
 *
 * Everything here is a guard rather than a feature. Creating a category is not
 * interesting; refusing the edit that would make stock unfindable, or the one
 * that would give two deliveries the same document number, is the whole reason
 * these services exist rather than a form wired straight to the table.
 */

let wh: Warehouse
const actor = () => ({ userId: wh.userId })

beforeEach(async () => {
  wh = await seedWarehouse()

  // seedWarehouse resets the TRANSACTIONAL tables and leaves master data alone,
  // which is right for every other suite and wrong for this one: these tests
  // create categories and sites by name, so without this the second test to ask
  // for "Consumables" fails on a row the first one left behind.
  //
  // FK checks off because categories reference themselves, so there is no order
  // that deletes a tree in one statement.
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0')
  await prisma.$executeRawUnsafe('DELETE FROM categories')
  await prisma.$executeRawUnsafe('DELETE FROM sites WHERE code <> ?', 'TEST')
  await prisma.$executeRawUnsafe('DELETE FROM number_sequences')
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1')
})

afterAll(async () => {
  await prisma.$disconnect()
})

const receive = (itemId: string, locationId: string, quantity: number) =>
  recordMovement(
    prisma,
    {
      id: randomUUID(),
      siteId: wh.siteId,
      action: { kind: 'RECEIVE', itemId, toLocationId: locationId, quantity },
      source: MovementSource.WEB,
    },
    { userId: wh.userId },
  )

/** A rejected movement has no document number, so the union has to be narrowed. */
function docNoOf(outcome: Awaited<ReturnType<typeof receive>>): string {
  if (outcome.status === 'REJECTED') {
    throw new Error(`the movement was rejected: ${JSON.stringify(outcome.error)}`)
  }

  return outcome.docNo
}

// ---------------------------------------------------------------------------

describe('categories · the tree', () => {
  it('lists children under their parent, indented', async () => {
    const parent = await createCategory(prisma, { name: 'Consumables' }, actor())
    await createCategory(prisma, { name: 'Gloves', parentId: parent.id }, actor())

    const tree = await listCategories(prisma)
    const gloves = tree.find((node) => node.name === 'Gloves')
    const consumables = tree.find((node) => node.name === 'Consumables')

    expect(consumables?.depth).toBe(0)
    expect(gloves?.depth).toBe(1)
    // Order matters: a child listed above its parent reads as a sibling.
    expect(tree.indexOf(consumables!)).toBeLessThan(tree.indexOf(gloves!))
  })

  it('refuses a category that would become its own ancestor', async () => {
    // The failure this prevents is not a bad row — it is every subsequent walk
    // of the tree running forever, including the one inside this check.
    const parent = await createCategory(prisma, { name: 'Consumables' }, actor())
    const child = await createCategory(prisma, { name: 'Gloves', parentId: parent.id }, actor())

    await expect(
      updateCategory(prisma, parent.id, { parentId: child.id }, actor()),
    ).rejects.toThrow(/inside one of its own sub-categories/i)
  })

  it('refuses a category that would be its own parent', async () => {
    const one = await createCategory(prisma, { name: 'Consumables' }, actor())

    await expect(updateCategory(prisma, one.id, { parentId: one.id }, actor())).rejects.toThrow(
      /its own parent/i,
    )
  })

  it('refuses a deeper cycle, not just the immediate one', async () => {
    const a = await createCategory(prisma, { name: 'A' }, actor())
    const b = await createCategory(prisma, { name: 'B', parentId: a.id }, actor())
    const c = await createCategory(prisma, { name: 'C', parentId: b.id }, actor())

    await expect(updateCategory(prisma, a.id, { parentId: c.id }, actor())).rejects.toThrow(
      /sub-categories/i,
    )
  })

  it('allows a legitimate reparent', async () => {
    const a = await createCategory(prisma, { name: 'A' }, actor())
    const b = await createCategory(prisma, { name: 'B' }, actor())

    await updateCategory(prisma, b.id, { parentId: a.id }, actor())

    const tree = await listCategories(prisma)
    expect(tree.find((node) => node.name === 'B')?.parentId).toBe(a.id)
  })

  it('keeps a category whose parent was removed visible', async () => {
    // Otherwise it exists in the database and appears on no screen, which means
    // nobody can fix it.
    const parent = await createCategory(prisma, { name: 'Consumables' }, actor())
    const child = await createCategory(prisma, { name: 'Gloves', parentId: parent.id }, actor())

    await prisma.category.update({ where: { id: parent.id }, data: { deletedAt: new Date() } })

    const tree = await listCategories(prisma)
    expect(tree.map((node) => node.id)).toContain(child.id)
  })
})

describe('categories · names', () => {
  it('refuses two siblings with the same name', async () => {
    await createCategory(prisma, { name: 'Consumables' }, actor())

    await expect(createCategory(prisma, { name: 'Consumables' }, actor())).rejects.toThrow(
      /already a top-level category/i,
    )
  })

  it('allows the same name under different parents', async () => {
    // "Tools > Spares" and "Vehicles > Spares" are different things.
    const tools = await createCategory(prisma, { name: 'Tools' }, actor())
    const vehicles = await createCategory(prisma, { name: 'Vehicles' }, actor())

    await createCategory(prisma, { name: 'Spares', parentId: tools.id }, actor())

    await expect(
      createCategory(prisma, { name: 'Spares', parentId: vehicles.id }, actor()),
    ).resolves.toBeTruthy()
  })

  it('collapses whitespace so two names cannot differ invisibly', async () => {
    await createCategory(prisma, { name: 'Safety  Gear' }, actor())

    await expect(createCategory(prisma, { name: ' Safety Gear ' }, actor())).rejects.toThrow(
      /already/i,
    )
  })

  it('refuses an empty name', async () => {
    await expect(createCategory(prisma, { name: '   ' }, actor())).rejects.toThrow(/needs a name/i)
  })
})

describe('categories · removal', () => {
  it('refuses to delete one that still has items', async () => {
    // Item.categoryId is ON DELETE SET NULL, so this would quietly uncategorise
    // the stock rather than fail.
    const category = await createCategory(prisma, { name: 'Consumables' }, actor())
    await prisma.item.update({ where: { id: wh.tapeId }, data: { categoryId: category.id } })

    await expect(deleteCategory(prisma, category.id, actor())).rejects.toThrow(/still has 1 item/i)
  })

  it('refuses to delete one that still has sub-categories', async () => {
    const parent = await createCategory(prisma, { name: 'Consumables' }, actor())
    await createCategory(prisma, { name: 'Gloves', parentId: parent.id }, actor())

    await expect(deleteCategory(prisma, parent.id, actor())).rejects.toThrow(/sub-categor/i)
  })

  it('deletes one nothing depends on, and leaves the audit trail able to name it', async () => {
    const category = await createCategory(prisma, { name: 'Temporary' }, actor())

    await deleteCategory(prisma, category.id, actor())

    expect((await listCategories(prisma)).map((node) => node.id)).not.toContain(category.id)
    // Soft-deleted, so the audit row still refers to something that exists.
    expect(await prisma.category.findUnique({ where: { id: category.id } })).not.toBeNull()
  })

  it('refuses to deactivate one holding stock', async () => {
    const category = await createCategory(prisma, { name: 'Consumables' }, actor())
    await prisma.item.update({ where: { id: wh.tapeId }, data: { categoryId: category.id } })
    await receive(wh.tapeId, wh.locationA, 10)

    await expect(updateCategory(prisma, category.id, { active: false }, actor())).rejects.toThrow(
      /stock on hand/i,
    )
  })

  it('allows deactivating one whose stock has gone', async () => {
    const category = await createCategory(prisma, { name: 'Consumables' }, actor())
    await prisma.item.update({ where: { id: wh.tapeId }, data: { categoryId: category.id } })

    await expect(
      updateCategory(prisma, category.id, { active: false }, actor()),
    ).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------

describe('sites', () => {
  it('uppercases codes so two spellings cannot name two sites', async () => {
    const site = await createSite(prisma, { code: 'wh2', name: 'Second warehouse' }, actor())

    expect(site.code).toBe('WH2')
    await expect(createSite(prisma, { code: 'WH2', name: 'Another' }, actor())).rejects.toThrow(
      /already in use/i,
    )
  })

  it('refuses a code with characters that would break paperwork', async () => {
    await expect(createSite(prisma, { code: 'WH 2!', name: 'Bad' }, actor())).rejects.toThrow(
      /letters, digits and hyphens/i,
    )
  })

  it('refuses to deactivate the only active site', async () => {
    // Every movement needs a site. With none active there is nowhere to receive
    // into, and the system is unusable until somebody edits the database.
    await expect(updateSite(prisma, wh.siteId, { active: false }, actor())).rejects.toThrow(
      /only active site/i,
    )
  })

  it('refuses to deactivate a site still holding stock', async () => {
    // The stock stays in the ledger, so the numbers still add up — and nobody
    // can find the goods. That is worse than an error.
    await createSite(prisma, { code: 'WH2', name: 'Second warehouse' }, actor())
    await receive(wh.tapeId, wh.locationA, 5)

    await expect(updateSite(prisma, wh.siteId, { active: false }, actor())).rejects.toThrow(
      /still holds stock/i,
    )
  })

  it('allows deactivating an empty site once another is active', async () => {
    const second = await createSite(prisma, { code: 'WH2', name: 'Second warehouse' }, actor())

    await expect(updateSite(prisma, second.id, { active: false }, actor())).resolves.toBeUndefined()
  })

  it('reports how much each site is holding', async () => {
    await receive(wh.tapeId, wh.locationA, 5)

    const sites = await listSites(prisma)
    const site = sites.find((row) => row.id === wh.siteId)

    expect(site?.stockedPlaces).toBeGreaterThan(0)
    expect(site?.locationCount).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------

describe('number sequences', () => {
  it('lists every document type, including ones never used', async () => {
    // Sequence rows are created lazily by the first document of their kind, so
    // a screen showing only existing rows is empty in January — hiding exactly
    // the sequences somebody wants to set up before going live.
    const rows = await listSequences(prisma, '2026')

    expect(rows.map((row) => row.key)).toContain('RECEIVE')
    expect(rows.map((row) => row.key)).toContain('SCRAP')
    expect(rows.every((row) => row.preview.length > 0)).toBe(true)
  })

  it('shows what the next document will actually be called', async () => {
    const rows = await listSequences(prisma, '2026')
    const receiveRow = rows.find((row) => row.key === 'RECEIVE')

    expect(receiveRow?.preview).toBe('RCV-2026-000001')
  })

  it('refuses to lower the next number', async () => {
    // The reason this service exists. Lowering reissues numbers already printed
    // on paperwork, and two documents with one name only surfaces months later,
    // in a recall, when the paperwork describes the wrong delivery.
    await updateSequence(prisma, 'RECEIVE', '2026', { nextValue: 500 }, actor())

    await expect(
      updateSequence(prisma, 'RECEIVE', '2026', { nextValue: 100 }, actor()),
    ).rejects.toThrow(/raised but not lowered/i)
  })

  it('names the last issued number when it refuses', async () => {
    await updateSequence(prisma, 'RECEIVE', '2026', { nextValue: 500 }, actor())

    await expect(
      updateSequence(prisma, 'RECEIVE', '2026', { nextValue: 100 }, actor()),
    ).rejects.toThrow(/RCV-2026-000499/)
  })

  it('allows raising it, for continuing from a previous system', async () => {
    const updated = await updateSequence(prisma, 'RECEIVE', '2026', { nextValue: 5000 }, actor())

    expect(updated.nextValue).toBe(5000)
    expect(updated.preview).toBe('RCV-2026-005000')
  })

  it('creates the row when it does not exist yet', async () => {
    await updateSequence(prisma, 'SCRAP', '2026', { nextValue: 42 }, actor())

    const row = await prisma.numberSequence.findUnique({
      where: { key_period: { key: 'SCRAP', period: '2026' } },
    })
    expect(row?.nextValue).toBe(42)
  })

  it('refuses a prefix the rest of the system cannot read back', async () => {
    // parseDocNo reads /^([A-Z]{3})-/, so a longer prefix produces numbers the
    // trace lookup silently stops finding.
    await expect(
      updateSequence(prisma, 'RECEIVE', '2026', { prefix: 'RECV' }, actor()),
    ).rejects.toThrow(/exactly three letters/i)
  })

  it('refuses a prefix another document type already uses', async () => {
    await expect(
      updateSequence(prisma, 'RECEIVE', '2026', { prefix: 'ISS' }, actor()),
    ).rejects.toThrow(/Stock issued/i)
  })

  it('refuses a prefix that another type would use by default', async () => {
    // An unused sequence still hands out its default prefix the moment somebody
    // records that kind of document, so the clash is real even with no row.
    await expect(
      updateSequence(prisma, 'RECEIVE', '2026', { prefix: 'SCR' }, actor()),
    ).rejects.toThrow(/Scrapped stock/i)
  })

  it('allows swapping prefixes once the other one has moved', async () => {
    await updateSequence(prisma, 'SCRAP', '2026', { prefix: 'SKP' }, actor())

    await expect(
      updateSequence(prisma, 'RECEIVE', '2026', { prefix: 'SCR' }, actor()),
    ).resolves.toBeTruthy()
  })

  it('refuses padding that would not fit a number', async () => {
    await expect(
      updateSequence(prisma, 'RECEIVE', '2026', { padding: 0 }, actor()),
    ).rejects.toThrow(/between 1 and 12/i)
  })

  it('records the change so a surprising number can be explained later', async () => {
    await updateSequence(prisma, 'RECEIVE', '2026', { nextValue: 5000 }, actor())

    const entry = await prisma.auditLog.findFirst({
      where: { entity: 'NumberSequence' },
      orderBy: { at: 'desc' },
    })

    expect(entry?.entityId).toBe('RECEIVE/2026')
    expect(entry?.after).toMatchObject({ nextValue: 5000 })
  })
})

describe('number sequences · the numbers that come out', () => {
  it('a raised sequence actually changes the next document number', async () => {
    // The point of the whole screen. Reading the value back proves nothing; a
    // real receipt has to come out with the new number.
    await updateSequence(
      prisma,
      'RECEIVE',
      String(new Date().getUTCFullYear()),
      {
        nextValue: 7000,
      },
      actor(),
    )

    const movement = await receive(wh.tapeId, wh.locationA, 1)

    expect(movement.status).toBe('RECORDED')
    expect(docNoOf(movement)).toMatch(/^RCV-\d{4}-007000$/)
  })

  it('a changed prefix actually changes the next document number', async () => {
    await updateSequence(
      prisma,
      'RECEIVE',
      String(new Date().getUTCFullYear()),
      {
        prefix: 'GRN',
      },
      actor(),
    )

    const movement = await receive(wh.tapeId, wh.locationA, 1)

    expect(movement.status).toBe('RECORDED')
    expect(docNoOf(movement)).toMatch(/^GRN-/)
  })
})
