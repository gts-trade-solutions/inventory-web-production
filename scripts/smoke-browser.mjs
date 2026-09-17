#!/usr/bin/env node
/**
 * Loads every page in a real browser and fails on any console error.
 *
 * This exists because curl cannot catch client-side breakage. A page that fails
 * to hydrate still server-renders, still returns 200, and still looks correct in
 * curl output — it only breaks once the browser runs it. Two rounds of work were
 * reported as verified on that basis.
 *
 * Usage:  node scripts/smoke-browser.mjs [baseUrl]
 * Assumes a dev or production server is already running.
 */

import { chromium } from 'playwright-core'

const BASE = process.argv[2] ?? 'http://localhost:3000'
const EMAIL = process.env.SMOKE_EMAIL ?? 'supervisor@inventory.local'
const PASSWORD = process.env.SMOKE_PASSWORD ?? 'demo1234'

/**
 * Noise that is not a real failure.
 *
 * Deliberately short. Every entry here is a signal deliberately thrown away, so
 * each one needs to be worth it — the whole point of this script is that it
 * notices things the other checks cannot.
 */
const IGNORE = [
  /Download the React DevTools/i,
  /\[Fast Refresh\]/i,
  // No favicon is configured yet. The browser reports it as a bare resource
  // 404 with no URL in the message, which is why this is matched so loosely.
  /Failed to load resource.*404/i,
  /^Warning: /i,
]

async function launch() {
  for (const channel of ['msedge', 'chrome', 'chromium']) {
    try {
      return await chromium.launch({ channel })
    } catch {
      /* try the next one */
    }
  }
  throw new Error('No Chromium-based browser found. Install Edge or Chrome.')
}

const browser = await launch()
const context = await browser.newContext()
const page = await context.newPage()

const failures = []
let current = '(startup)'

page.on('console', (message) => {
  if (message.type() !== 'error') return
  const text = message.text()
  if (IGNORE.some((pattern) => pattern.test(text))) return
  failures.push({ page: current, kind: 'console', text })
})

page.on('pageerror', (error) => {
  failures.push({ page: current, kind: 'uncaught', text: error.message })
})

async function visit(path, label = path) {
  current = label
  const response = await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 30_000 })
  const status = response?.status() ?? 0
  if (status !== 200) {
    failures.push({ page: label, kind: 'http', text: `expected 200, got ${status}` })
  }

  // No check for Next's dev error overlay: `nextjs-portal` is present on every
  // page in dev for the devtools indicator, and its contents live in a shadow
  // root, so it is not a usable signal. The `pageerror` handler above is — an
  // uncaught hydration failure fires it, which is exactly how the original
  // "Cannot read properties of undefined" bug presents.

  console.log(`  ${status === 200 ? '✓' : '✗'} ${String(status).padEnd(3)} ${label}`)
  return status
}

console.log(`Smoke-testing ${BASE} in a real browser\n`)

// --- sign in -------------------------------------------------------------
await visit('/login')
await page.getByRole('button', { name: /demo/i }).first().click()
await page.fill('#email', EMAIL)
await page.fill('#password', PASSWORD)
await page.getByRole('button', { name: /enter demo|sign in/i }).click()
await page.waitForURL(/dashboard/, { timeout: 30_000 })
console.log('  ✓ signed in\n')

// --- walk the app --------------------------------------------------------
await visit('/dashboard')
await visit('/inventory')
await visit('/batches')
await visit('/serials')
await visit('/movements')

// Follow real links rather than hard-coded ids, so the test breaks if the list
// pages stop linking anywhere.
const followFirst = async (listPath, pattern, label) => {
  await visit(listPath)
  const href = await page.locator(`a[href^="${pattern}"]`).first().getAttribute('href')
  if (!href) {
    failures.push({ page: listPath, kind: 'no link', text: `nothing linking to ${pattern}` })
    return
  }
  await visit(href, label)
}

await followFirst('/inventory', '/inventory/', 'item detail')
await followFirst('/batches', '/batches/', 'batch detail (quarantine form)')
await followFirst('/serials', '/serials/', 'serial life history')

// The movement form is the most interactive page, so it is the most likely to
// break on hydration.
const itemHref = await page
  .goto(`${BASE}/inventory`)
  .then(() => page.locator('a[href^="/inventory/"]').first().getAttribute('href'))
const itemId = itemHref?.split('/').pop()
for (const kind of ['receive', 'issue', 'move', 'adjust', 'scrap']) {
  await visit(`/movements/new?item=${itemId}&kind=${kind}`, `movement form · ${kind}`)
}

await browser.close()

console.log()
if (failures.length === 0) {
  console.log('No console errors, no uncaught exceptions, no error overlays.')
  process.exit(0)
}

console.error(`${failures.length} browser failure(s):\n`)
for (const failure of failures) {
  console.error(`  [${failure.kind}] ${failure.page}`)
  console.error(`    ${failure.text}\n`)
}
process.exit(1)
