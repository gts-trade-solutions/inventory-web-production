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
// Read from the same definition the seed and the login screen use, so a password
// change that breaks the demo breaks this check too rather than going unnoticed.
import { DEMO_ACCOUNTS } from '../lib/demo-accounts.ts'

const BASE = process.argv[2] ?? 'http://localhost:3000'
const SUPERVISOR = DEMO_ACCOUNTS.find((account) => account.role === 'SUPERVISOR')
const EMAIL = process.env.SMOKE_EMAIL ?? SUPERVISOR.email
const PASSWORD = process.env.SMOKE_PASSWORD ?? SUPERVISOR.password

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
await visit('/scan')
await visit('/counts')

// Follow real links rather than hard-coded ids, so the test breaks if the list
// pages stop linking anywhere.
//
// The href must end in a UUID. The first /inventory/ link on that page is
// "/inventory/new" — the Add item button — so taking the first match meant
// "item detail" was really visiting the new-item form, and the movement-form
// checks below were run against an item id of the literal string "new". They
// returned 200 and proved nothing.
const UUID_HREF = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const firstRecordHref = async (pattern) => {
  const hrefs = await page.locator(`a[href^="${pattern}"]`).evaluateAll((anchors) =>
    anchors.map((anchor) => anchor.getAttribute('href')),
  )
  return hrefs.find((href) => href && UUID_HREF.test(href)) ?? null
}

const followFirst = async (listPath, pattern, label) => {
  await visit(listPath)
  const href = await firstRecordHref(pattern)
  if (!href) {
    failures.push({ page: listPath, kind: 'no link', text: `no record linked from ${pattern}` })
    return
  }
  await visit(href, label)
}

await followFirst('/inventory', '/inventory/', 'item detail')
await followFirst('/batches', '/batches/', 'batch detail (quarantine form)')
await followFirst('/serials', '/serials/', 'serial life history')

// The movement form is the most interactive page, so it is the most likely to
// break on hydration.
await page.goto(`${BASE}/inventory`, { waitUntil: 'networkidle' })
const itemHref = await firstRecordHref('/inventory/')
if (!itemHref) {
  failures.push({ page: '/inventory', kind: 'no link', text: 'no item to drive the forms with' })
}
const itemId = itemHref?.split('/').pop()
for (const kind of ['receive', 'issue', 'move', 'adjust', 'scrap']) {
  await visit(`/movements/new?item=${itemId}&kind=${kind}`, `movement form · ${kind}`)
}

// --- an RFID cycle count, start to finish --------------------------------
// The flagship workflow. Driven end to end because every piece works in
// isolation and the question that matters is whether they work together.
{
  await visit('/counts')

  const start = page.getByRole('button', { name: /start count|start/i }).first()
  if ((await start.count()) === 0) {
    failures.push({ page: '/counts', kind: 'missing', text: 'no way to start a count' })
  } else {
    current = 'counts · start'

    // Pick the first location offered, and RFID as the method where available.
    const locationSelect = page.locator('select[name="locationId"]').first()
    if (await locationSelect.count()) {
      const value = await locationSelect.locator('option').nth(1).getAttribute('value')
      if (value) await locationSelect.selectOption(value)
    }
    const methodSelect = page.locator('select[name="method"]').first()
    if (await methodSelect.count()) await methodSelect.selectOption('RFID').catch(() => {})

    await start.click()
    await page.waitForURL(/\/counts\/[0-9a-f-]{36}/, { timeout: 30_000 })
    console.log('  ✓     counts · session started')

    current = 'counts · sweep'
    const sweepButton = page.getByRole('button', { name: /sweep with rfid/i }).first()
    if ((await sweepButton.count()) === 0) {
      failures.push({ page: 'counts', kind: 'missing', text: 'no RFID sweep button' })
    } else {
      await sweepButton.click()
      // Wait for the reader's own sentence, which only exists after the sweep.
      await page.getByText(/saw \d+ tag|saw no tags|reader/i).first().waitFor({ timeout: 30_000 })

      const note = await page.getByText(/saw \d+ tag|saw no tags/i).first().textContent()
      console.log(`  ✓     counts · sweep — ${note?.trim()}`)

      if (!/simulation/i.test(note ?? '')) {
        // The badge is not optional. A simulated read that does not say so is
        // how a demo gets mistaken for a live system.
        failures.push({
          page: 'counts · sweep',
          kind: 'honesty',
          text: `sweep result did not say it was simulated: ${note}`,
        })
      }
    }
  }
}

// --- printing a label ----------------------------------------------------
// Printed for real, not just rendered. The preview is parsed from the bytes
// that go to the printer, so a broken render is a broken job.
{
  await visit(`/labels?item=${itemId}`, '/labels')

  current = 'labels · preview'
  // The SVG only appears once the server has rendered the ZPL.
  await page.getByRole('img', { name: /label preview/i }).first().waitFor({ timeout: 30_000 })

  const bars = await page.locator('svg[role="img"] rect').count()
  if (bars < 30) {
    // An EAN-13 is 95 modules; roughly 30 of them are bars. A preview with a
    // handful of rectangles means the barcode did not render.
    failures.push({
      page: '/labels',
      kind: 'preview',
      text: `label preview drew only ${bars} shapes — the barcode probably did not render`,
    })
  }
  console.log(`  ✓     labels · preview drew ${bars} shapes`)

  current = 'labels · print'
  await page.getByRole('button', { name: /^print$/i }).first().click()
  await page.getByText(/PRN-\d{4}-\d{6}/).first().waitFor({ timeout: 30_000 })

  const receipt = await page.getByText(/PRN-\d{4}-\d{6}/).first().textContent()
  console.log(`  ✓     labels · printed — ${receipt?.trim().slice(0, 70)}`)
}

// --- devices -------------------------------------------------------------
// The self-test is clicked, not just rendered. It is a server action driving a
// device connector, and "the page loaded" says nothing about whether pressing
// the button works.
await visit('/devices')

const selfTest = page.getByRole('button', { name: /self-test/i }).first()
if ((await selfTest.count()) === 0) {
  failures.push({ page: '/devices', kind: 'missing', text: 'no self-test button' })
} else {
  current = 'devices · self-test'
  await selfTest.click()

  // Wait for something that can only exist AFTER the action returns. Waiting on
  // "Simulation" matched the badge already on the page, so the assertions below
  // ran before the report had rendered and passed for the wrong reason.
  await page.getByText(/^\d+ms$/).first().waitFor({ timeout: 30_000 })

  // The report must name its steps and say how long each took. A bare tick
  // would mean nothing on hardware day, which is the whole point of a
  // self-test.
  const reported = await page.getByText(/^\d+ms$/).count()
  if (reported < 2) {
    failures.push({
      page: '/devices',
      kind: 'empty',
      text: `self-test reported ${reported} step(s); expected a step-by-step report`,
    })
  }
  console.log(`  ✓     devices · self-test reported ${reported} step(s)`)
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
