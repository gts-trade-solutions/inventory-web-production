#!/usr/bin/env node
/**
 * Fails if anything that can reach data is missing its server-side guard.
 *
 * Plan item 7.7 asks for a role-enforcement audit. An audit is a snapshot: it
 * is true on the day somebody does it and quietly stops being true afterwards.
 * This is the same check, run on every push.
 *
 * It exists because twice now a rule that was written down turned out not to be
 * enforced anywhere — the demo device binding and the outbound-effect gate. A
 * rule a script can check is worth more than a rule in a document.
 *
 * Deliberately crude: it looks for the guard call by name rather than
 * understanding the code. That means it cannot be fooled by an unusual shape
 * without somebody noticing the failure and adding the file to an exemption
 * list, which is a conversation rather than an accident.
 *
 *   npm run check:guards
 */

import { globSync, readFileSync } from 'node:fs'

const ROOT = process.cwd()

/**
 * Files that legitimately have no guard, each with the reason.
 *
 * Adding to this list should feel like a decision. That is the point.
 */
const EXEMPT = new Map([
  ['app/(auth)/login/actions.ts', 'the login itself — guarding it would lock everybody out'],
  ['app/(app)/actions.ts', 'sign-out only; it is safe for anyone and runs inside the authed layout'],
  ['app/api/v1/health/route.ts', 'deliberately public: reachability, checked before any session exists'],
  ['app/api/v1/stream/route.ts', 'verifies the bearer token itself, because SSE cannot use the JSON wrapper'],
  ['app/api/auth/[...nextauth]/route.ts', "Auth.js's own handler"],
])

const PAGE_GUARDS = ['requireUser(', 'requireRole(']
const ACTION_GUARDS = ['requireUser(', 'requireRole(']
const ROUTE_GUARDS = ['apiRoute(', 'publicRoute(']

const problems = []

function relative(path) {
  return path.replace(`${ROOT}\\`, '').replace(`${ROOT}/`, '').replaceAll('\\', '/')
}

function check(path, guards, what) {
  const name = relative(path)
  if (EXEMPT.has(name)) return

  const source = readFileSync(path, 'utf8')
  if (guards.some((guard) => source.includes(guard))) return

  problems.push({ name, what, guards })
}

// --- pages ----------------------------------------------------------------
// Everything under the authenticated shell. The layout guards too, but a page
// that does not is one route-group move away from being public.
for (const path of globSync('app/(app)/**/page.tsx', { cwd: ROOT, absolute: true })) {
  check(path, PAGE_GUARDS, 'a page under the authenticated shell')
}

// --- server actions -------------------------------------------------------
// A Server Action is a POST endpoint with a nicer syntax. Being imported by a
// guarded page protects nothing: the browser can call it directly.
for (const path of globSync('app/**/*.ts', { cwd: ROOT, absolute: true })) {
  const source = readFileSync(path, 'utf8')
  if (!source.startsWith("'use server'")) continue

  check(path, ACTION_GUARDS, 'a Server Action file')

  /**
   * A "use server" file may only export async functions.
   *
   * Types and interfaces are fine because they are erased. Anything else — a
   * constant, a class, a plain function — makes Next throw AT RUNTIME, on a
   * file that compiles, typechecks and lints cleanly. It has caught me out
   * twice; both times the page 500'd and only the browser smoke test noticed.
   */
  const offenders = [...source.matchAll(/^export\s+(const|let|var|class|function)\s+(\w+)/gm)]
    .filter((match) => match[1] !== 'function' || !/^export\s+function/.test(match[0]))
    .map((match) => `${match[1]} ${match[2]}`)

  if (offenders.length > 0) {
    problems.push({
      name: relative(path),
      what: `a Server Action file exporting ${offenders.join(', ')}`,
      guards: ['only async functions, types and interfaces may be exported'],
    })
  }
}

// --- API routes -----------------------------------------------------------
for (const path of globSync('app/api/**/route.ts', { cwd: ROOT, absolute: true })) {
  check(path, ROUTE_GUARDS, 'an API route')
}

// --- report ---------------------------------------------------------------
if (problems.length === 0) {
  const counted = [
    globSync('app/(app)/**/page.tsx', { cwd: ROOT }).length,
    globSync('app/api/**/route.ts', { cwd: ROOT }).length,
  ]
  console.log(
    `Guards OK — ${counted[0]} pages and ${counted[1]} API routes, every one authenticated server-side` +
      ` (${EXEMPT.size} documented exemptions).`,
  )
  process.exit(0)
}

console.error(`${problems.length} unguarded file(s):\n`)
for (const problem of problems) {
  console.error(`  ${problem.name}`)
  console.error(`    ${problem.what} with none of: ${problem.guards.join(', ')}`)
  console.error(
    '    Add the guard, or add the file to EXEMPT in scripts/check-guards.mjs with a reason.\n',
  )
}
process.exit(1)
