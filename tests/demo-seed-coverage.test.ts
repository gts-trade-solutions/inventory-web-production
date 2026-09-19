import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Everything the demo seed WRITES must also be something it CLEARS.
 *
 * A table missing from the truncation list does not fail. It ACCUMULATES —
 * every demo reset adds another copy, and nothing complains. Ten resets had
 * left ten copies of every putaway rule before anybody counted them, and the
 * only symptom was a suggestion engine quietly considering the same rule ten
 * times.
 *
 * Checked by reading the source rather than by running the seed: running it
 * would wipe whatever the developer has on screen, which is the same reason
 * demo-reset.integration.test.ts leaves the happy path alone.
 *
 * Deliberately crude, in the manner of scripts/check-guards.mjs — it matches
 * text rather than understanding the code. That means it cannot be fooled
 * quietly: an unusual shape fails the test and somebody has to look.
 */

const source = readFileSync(join(process.cwd(), 'prisma', 'seed-demo.ts'), 'utf8')

/** `prisma.putawayRule.createMany` → `putawayRule` */
function modelsWritten(): string[] {
  const writes = [...source.matchAll(/prisma\.(\w+)\.(create|createMany|upsert)\b/g)]
  return [...new Set(writes.map((match) => match[1]!))]
}

/** The array passed to the truncation loop. */
function tablesCleared(): string[] {
  const block = /for \(const table of \[([\s\S]*?)\]\)/.exec(source)
  if (!block) throw new Error('could not find the truncation list in prisma/seed-demo.ts')

  return [...block[1]!.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!)
}

/**
 * Prisma's camelCase model name to the snake_case table it maps to.
 *
 * English pluralisation, only as far as the names in schema.prisma actually
 * need: `batch` -> `batches`, `category` -> `categories`, everything else -> s.
 * The first draft produced `batchs` and the test caught it on itself, which is
 * the correct amount of confidence to have in a rule like this.
 */
function tableFor(model: string): string {
  const snake = model.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)

  if (/(ch|sh|s|x|z)$/.test(snake)) return `${snake}es`
  if (/[^aeiou]y$/.test(snake)) return `${snake.slice(0, -1)}ies`
  return `${snake}s`
}

describe('the demo seed', () => {
  it('finds tables to clear', () => {
    expect(tablesCleared().length).toBeGreaterThan(10)
  })

  it('finds models it writes to', () => {
    expect(modelsWritten().length).toBeGreaterThan(5)
  })

  it('clears every table it writes to', () => {
    const cleared = new Set(tablesCleared())

    const missing = modelsWritten()
      .map((model) => ({ model, table: tableFor(model) }))
      .filter((entry) => !cleared.has(entry.table))

    expect(
      missing,
      `prisma/seed-demo.ts writes to ${missing
        .map((entry) => `${entry.model} (${entry.table})`)
        .join(', ')} but never clears it. Every reset would add another copy. ` +
        'Add the table to the truncation list, before anything it references.',
    ).toEqual([])
  })

  it('clears putaway rules before the locations they point at', () => {
    // Ordering matters as much as membership: a table referencing another must
    // be emptied first or the delete is refused by the foreign key.
    const cleared = tablesCleared()

    expect(cleared.indexOf('putaway_rules')).toBeGreaterThanOrEqual(0)
    expect(cleared.indexOf('putaway_rules')).toBeLessThan(cleared.indexOf('locations'))
    expect(cleared.indexOf('putaway_rules')).toBeLessThan(cleared.indexOf('categories'))
  })
})
