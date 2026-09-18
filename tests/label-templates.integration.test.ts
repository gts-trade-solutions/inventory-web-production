import { randomUUID } from 'node:crypto'
import { LabelKind } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  listTemplates,
  saveTemplate,
  setTemplateActive,
  validateTemplate,
} from '@/lib/services/label-templates'
import { requirementsOf, sampleFields } from '@/lib/labels/fields'
import { renderTemplate } from '@/lib/labels/zpl'
import { prisma, seedWarehouse } from './helpers/warehouse'

/**
 * The label template editor.
 *
 * Templates live in the database so a label can change without a release. The
 * cost is that an administrator can now save something a printer cannot use, so
 * what is tested here is mostly what the editor REFUSES.
 */

const VALID = [
  '^XA^CI28^PW812^LL406',
  '^FO30,30^A0N,40,40^FD{{itemName}}^FS',
  '^FO30,125^A0N,28,28^FDSKU {{sku}}^FS',
  '^XZ',
].join('\n')

beforeEach(async () => {
  await seedWarehouse()
  await prisma.printJob.deleteMany()
  await prisma.labelTemplate.deleteMany()
})

afterAll(async () => {
  await prisma.$disconnect()
})

const template = (overrides: Partial<Parameters<typeof saveTemplate>[1]> = {}) => ({
  name: `Template ${randomUUID().slice(0, 8)}`,
  kind: LabelKind.ITEM,
  zplBody: VALID,
  widthMm: 102,
  heightMm: 51,
  dpi: 203,
  rfidEncode: false,
  ...overrides,
})

describe('what it refuses', () => {
  it('an unterminated document', () => {
    // The printer waits for the rest of a job that never arrives, and the next
    // job arrives into that state.
    const problems = validateTemplate({ zplBody: '^XA^FDx^FS', rfidEncode: false })

    expect(problems[0]).toMatch(/\^XZ/)
  })

  it('a placeholder nothing can fill', () => {
    // The template could never print, and nobody would find out until somebody
    // tried.
    const problems = validateTemplate({
      zplBody: '^XA^FD{{itemname}}^FS^XZ',
      rfidEncode: false,
    })

    expect(problems[0]).toMatch(/\{\{itemname\}\}/)
    expect(problems[0]).toMatch(/can never print/)
  })

  it('a template carrying its own ^RFW', () => {
    // Tag data is added per label when printing. A template with its own would
    // put the same tag on every label in the run (WADR-009).
    const problems = validateTemplate({
      zplBody: '^XA^RS8^RFW,H^FD30361F49C800004000000001^FS^XZ',
      rfidEncode: true,
    })

    expect(problems.some((problem) => /same tag on every label/.test(problem))).toBe(true)
  })

  it('^PQ on an RFID template', () => {
    const problems = validateTemplate({
      zplBody: '^XA^FD{{sku}}^FS^PQ5^XZ',
      rfidEncode: true,
    })

    expect(problems.some((problem) => /Copies repeat the same tag data/.test(problem))).toBe(true)
  })

  it('allows ^PQ on a plain template', () => {
    expect(validateTemplate({ zplBody: '^XA^FD{{sku}}^FS^PQ5^XZ', rfidEncode: false })).toEqual([])
  })

  it('accepts a good one', () => {
    expect(validateTemplate({ zplBody: VALID, rfidEncode: false })).toEqual([])
  })

  it('refuses to save an invalid one', async () => {
    await expect(
      saveTemplate(prisma, template({ zplBody: '^XA^FDbroken^FS' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })

    expect(await prisma.labelTemplate.count()).toBe(0)
  })
})

describe('saving', () => {
  it('stores a template and reports what it will need', async () => {
    const saved = await saveTemplate(prisma, template())

    expect(saved.needs).toEqual(['item'])
    expect(saved.usedBy).toBe(0)
  })

  it('works out that a batch label needs a batch', async () => {
    const saved = await saveTemplate(
      prisma,
      template({
        kind: LabelKind.BATCH,
        zplBody: '^XA^FD{{itemName}}^FS^FD{{batchNo}}^FS^FD{{expiryDate}}^FS^XZ',
      }),
    )

    expect(saved.needs.sort()).toEqual(['batch', 'item'])
  })

  it('updates in place rather than creating a second', async () => {
    const first = await saveTemplate(prisma, template({ name: 'Item label' }))
    const updated = await saveTemplate(
      prisma,
      template({ name: 'Item label', zplBody: '^XA^FD{{sku}}^FS^XZ' }),
      first.id,
    )

    expect(updated.id).toBe(first.id)
    expect(await prisma.labelTemplate.count()).toBe(1)
  })

  it('refuses a duplicate name', async () => {
    await saveTemplate(prisma, template({ name: 'Item label' }))

    await expect(saveTemplate(prisma, template({ name: 'Item label' }))).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  it('refuses to update one that does not exist', async () => {
    await expect(saveTemplate(prisma, template(), randomUUID())).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})

describe('retiring', () => {
  it('deactivates rather than deletes', async () => {
    // Print jobs reference the template, and a job record is the only link
    // between a physical RFID tag and the unit it belongs to.
    const saved = await saveTemplate(prisma, template())

    await setTemplateActive(prisma, saved.id, false)

    const [row] = await listTemplates(prisma)
    expect(row?.active).toBe(false)
    expect(await prisma.labelTemplate.count()).toBe(1)
  })

  it('can be brought back', async () => {
    const saved = await saveTemplate(prisma, template())
    await setTemplateActive(prisma, saved.id, false)
    await setTemplateActive(prisma, saved.id, true)

    expect((await listTemplates(prisma))[0]?.active).toBe(true)
  })
})

describe('the sample values', () => {
  it('fill every field a template can reference', () => {
    // The editor previews with these. If one were missing, the preview would
    // refuse for a template that prints perfectly well in practice.
    const zpl = '^XA' + requirementsOf([]).needs.join('') +
      ['itemName', 'sku', 'barcode12', 'batchNo', 'expiryDate', 'code', 'printedOn']
        .map((field) => `^FD{{${field}}}^FS`)
        .join('') +
      '^XZ'

    expect(() => renderTemplate(zpl, sampleFields())).not.toThrow()
  })

  it('give a valid EAN-13 sample, so the preview draws real bars', () => {
    const rendered = renderTemplate('^XA^BEN,150,Y,N^FD{{barcode12}}^FS^XZ', sampleFields())

    expect(rendered).toMatch(/\^FD\d{12}\^FS/)
  })
})
