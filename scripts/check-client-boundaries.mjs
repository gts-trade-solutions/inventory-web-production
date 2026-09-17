#!/usr/bin/env node
/**
 * Fails the build if a client component imports server-only code as a VALUE.
 *
 * Such an import is legal TypeScript: it compiles, lints, builds and
 * server-renders cleanly, and only misbehaves once a browser runs it. Nothing
 * else in the pipeline catches it, because nothing else executes client
 * JavaScript.
 *
 * Severity varies by module, and the list below is ordered accordingly:
 *
 *   - `server-only` is designed to throw on the client. It always breaks.
 *   - `@/lib/db`, `bcryptjs` and `node:crypto` pull Node built-ins into the
 *     browser bundle and fail to resolve.
 *   - `@prisma/client` was measured NOT to crash — Next resolves the enum and
 *     the page still hydrates. It is blocked anyway, because dragging the Prisma
 *     client into a browser bundle is pure weight for a string union that can be
 *     declared in three lines.
 *
 * ESLint overrides would need a hand-maintained list of client components; this
 * finds them by reading the 'use client' directive, so a new one is covered the
 * moment it is written.
 *
 * TYPE imports are always fine — they are erased at compile time.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOTS = ['app', 'components', 'lib']

/** Modules that cannot exist in a browser bundle. */
const SERVER_ONLY = [
  {
    module: '@prisma/client',
    hint: 'Declare the union type locally; the string values are identical.',
  },
  {
    module: 'server-only',
    hint: 'This module exists to make the import fail. Move the logic server-side.',
  },
  { module: '@/lib/db', hint: 'Database access belongs in a Server Action or a Server Component.' },
  { module: 'bcryptjs', hint: 'Hashing belongs on the server.' },
  { module: 'node:crypto', hint: 'Use crypto.randomUUID() from the Web Crypto API instead.' },
]

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      yield* walk(path)
    } else if (/\.(tsx|ts)$/.test(path)) {
      yield path
    }
  }
}

/** Removes block and line comments so their contents cannot be mistaken for code. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(
      /(^|[^:'"\\])\/\/[^\n]*/g,
      (match, prefix) => prefix + ' '.repeat(match.length - prefix.length),
    )
}

/**
 * Yields [clause, specifier, index] for each import statement.
 *
 * The clause is not allowed to contain another `import`, which is what stops a
 * match starting at one statement and ending at a later one's specifier. Regex
 * alternation is leftmost-first, so without that guard an earlier import is
 * reported as importing a module three statements below it.
 */
function* imports(code) {
  const pattern = /\bimport\s+((?:(?!\bimport\b)[\s\S])*?)\s*from\s*['"]([^'"]+)['"]/g

  for (const match of code.matchAll(pattern)) {
    yield [match[1] ?? '', match[2] ?? '', match.index ?? 0]
  }

  // Side-effect imports have no clause and no `from`: `import 'server-only'`.
  // That is exactly how `server-only` is meant to be used, so missing this form
  // would miss the import the whole check is named after.
  for (const match of code.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) {
    yield ['', match[1] ?? '', match.index ?? 0]
  }
}

function isTypeOnly(clause) {
  if (/^type\b/.test(clause.trim())) return true

  const names = /\{([\s\S]*)\}/.exec(clause)?.[1]
  if (!names) return false

  const bindings = names.split(',').filter((name) => name.trim().length > 0)
  return bindings.length > 0 && bindings.every((name) => /^\s*type\s/.test(name))
}

const problems = []

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const source = readFileSync(file, 'utf8')

    // The directive must be the first statement for Next to honour it.
    if (!/^\s*['"]use client['"]/.test(source)) continue

    // Comments are stripped first. A comment explaining this very rule mentions
    // the module name, and without stripping the checker flags its own
    // documentation.
    const code = stripComments(source)

    for (const [clause, specifier, index] of imports(code)) {
      const rule = SERVER_ONLY.find((candidate) => candidate.module === specifier)
      if (!rule) continue

      // `import type { X } from …` and `import { type X } from …` are both
      // erased at compile time and cannot reach the browser.
      if (isTypeOnly(clause)) continue

      problems.push({
        file: relative(process.cwd(), file),
        line: code.slice(0, index).split('\n').length,
        module: rule.module,
        hint: rule.hint,
      })
    }
  }
}

if (problems.length === 0) {
  console.log('Client boundaries OK — no server-only value imports in client components.')
  process.exit(0)
}

console.error('\nServer-only code imported into a client component:\n')
for (const problem of problems) {
  console.error(`  ${problem.file}:${problem.line}`)
  console.error(`    imports "${problem.module}" as a value.`)
  console.error(`    ${problem.hint}\n`)
}
console.error(
  'This compiles, builds and server-renders fine, then fails in the browser with\n' +
    '"Cannot read properties of undefined (reading \'call\')". Fix it before shipping.\n',
)
process.exit(1)
