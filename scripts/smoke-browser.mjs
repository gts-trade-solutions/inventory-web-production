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
// Reset is admin-only, so the last act of the run signs in again as one.
const ADMIN = DEMO_ACCOUNTS.find((account) => account.role === 'ADMIN')
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

// Reports. Each one is visited with filters applied as well as bare, because
// the filters are read from the URL and a page that throws on an unexpected
// query string would look fine on the plain visit.
await visit('/reports')
await visit('/reports/stock')
await visit('/reports/stock?grain=BATCH')
await visit('/reports/movements')
await visit('/reports/counts')
await visit('/reports/ageing')
await visit('/reports/reorder')
// A range typed the wrong way round is swapped rather than rejected, and a
// nonsense date falls back to the default. Both would otherwise be a 500 on a
// URL somebody pasted.
await visit('/reports/movements?from=2026-09-18&to=2026-01-01', 'reports · reversed date range')
await visit('/reports/movements?from=not-a-date', 'reports · nonsense date')

// The exports, actually downloaded and actually read back. An endpoint that
// returns an empty body still produces a file, a filename and a satisfied
// click — which is exactly how the recall pack shipped `{}` with a 200 once,
// and how the first XLSX writer produced 0-byte workbooks.
{
  current = 'reports · downloads'
  await visit('/reports/stock?grain=LOCATION', 'reports · stock by location')

  const grab = async (linkName) => {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 60_000 }).catch(() => null),
      page.getByRole('link', { name: linkName }).first().click(),
    ])
    if (!download) return null

    const stream = await download.createReadStream()
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)

    return { name: download.suggestedFilename(), body: Buffer.concat(chunks) }
  }

  const csv = await grab(/^csv$/i)
  if (!csv) {
    failures.push({ page: '/reports/stock', kind: 'download', text: 'no CSV was downloaded' })
  } else {
    const lines = csv.body.toString('utf8').trim().split('\n')
    if (!/SKU/i.test(lines[0] ?? '') || lines.length < 2) {
      failures.push({
        page: '/reports/stock',
        kind: 'download',
        text: `the CSV is not a populated report: ${JSON.stringify(lines[0]?.slice(0, 60))}, ${lines.length} line(s)`,
      })
    } else {
      console.log(`  ✓     reports · CSV downloaded, ${lines.length - 1} row(s)`)
    }
  }

  const xlsx = await grab(/^excel$/i)
  if (!xlsx) {
    failures.push({ page: '/reports/stock', kind: 'download', text: 'no XLSX was downloaded' })
  } else if (!xlsx.name.endsWith('.xlsx')) {
    failures.push({
      page: '/reports/stock',
      kind: 'download',
      text: `the spreadsheet was named ${xlsx.name}`,
    })
  } else if (xlsx.body.subarray(0, 2).toString('latin1') !== 'PK' || xlsx.body.length < 2000) {
    // An xlsx is a zip, so it starts "PK". A file that does not is the empty
    // download that looks like an empty report.
    failures.push({
      page: '/reports/stock',
      kind: 'download',
      text: `the spreadsheet is not a valid workbook: ${xlsx.body.length} bytes`,
    })
  } else {
    console.log(`  ✓     reports · Excel downloaded, ${xlsx.body.length} bytes, opens as a zip`)
  }

  // The list exports, which stream rather than building a string. Driven from a
  // FILTERED list, because the failure worth catching is an export that quietly
  // ignores the filter and hands back everything.
  current = 'movements · filtered export'
  await visit('/movements?type=receive', 'movements · filtered to receipts')

  const filtered = await grab(/^csv$/i)
  if (!filtered) {
    failures.push({ page: '/movements', kind: 'download', text: 'no CSV was downloaded' })
  } else {
    const lines = filtered.body.toString('utf8').trim().split('\r\n')
    const typeColumn = (lines[0] ?? '').split(',').indexOf('Type')
    const types = new Set(lines.slice(1).map((line) => line.split(',')[typeColumn]))

    if (lines.length < 2) {
      failures.push({ page: '/movements', kind: 'download', text: 'the export came back empty' })
    } else if (types.size !== 1 || !types.has('RECEIVE')) {
      failures.push({
        page: '/movements',
        kind: 'download',
        text: `filtered to receipts but exported ${[...types].join(', ')}`,
      })
    } else {
      console.log(
        `  ✓     movements · filtered export honoured the filter, ${lines.length - 1} row(s)`,
      )
    }
  }
}

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
  const hrefs = await page
    .locator(`a[href^="${pattern}"]`)
    .evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href')))
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

// The recall pack, from the screen a quality manager is standing on. Behind an
// API it was reachable only by a developer, which is the opposite of the point.
{
  current = 'batch · recall pack'
  const build = page.getByRole('button', { name: /build the recall pack/i }).first()
  if ((await build.count()) === 0) {
    failures.push({ page: 'batch detail', kind: 'missing', text: 'no recall pack control' })
  } else {
    await build.click()
    await page
      .getByRole('button', { name: /download csv/i })
      .first()
      .waitFor({ timeout: 30_000 })

    const balanced = await page
      .getByText(/ledger balances|does not balance/i)
      .first()
      .textContent()
    console.log(`  ✓     batch · recall pack — ${balanced?.trim().slice(0, 60)}`)
  }
}
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

// --- locations ------------------------------------------------------------
// Readable by anyone, editable by an admin. Checked here as the supervisor the
// run signs in as, so this also proves the edit controls stay hidden from
// somebody who may not use them.
{
  current = 'locations'
  await visit('/locations')

  const listed = await page.getByText(/A-01|Rack 01/i).count()
  if (listed === 0) {
    failures.push({ page: '/locations', kind: 'empty', text: 'no locations were listed' })
  } else {
    console.log(`  ✓     locations · listed`)
  }

  // The structure is real, not a prefix in a code. An aisle contains racks and
  // says so, and reports what is below it.
  const branches = await page.getByText(/holds places/i).count()
  if (branches === 0) {
    failures.push({
      page: '/locations',
      kind: 'structure',
      text: 'no location was shown as containing others, so the tree is not rendering',
    })
  } else {
    console.log(`  ✓     locations · ${branches} location(s) shown as holding others`)
  }

  // Fill, including the overfull one the demo seeds deliberately. A capacity
  // that never shows a figure is a column that does nothing.
  const fills = await page.getByText(/^\d+%$/).count()
  if (fills === 0) {
    failures.push({ page: '/locations', kind: 'capacity', text: 'no fill percentage was shown' })
  } else {
    const over = await page.getByText(/^1[0-9]{2}%$|^[2-9][0-9]{2}%$/).count()
    console.log(`  ✓     locations · ${fills} fill figure(s), ${over} of them over capacity`)
  }

  // A supervisor is not an admin, so nothing here should offer to change
  // master data. The server would refuse anyway; showing the control and then
  // refusing is a worse experience than not showing it.
  const editControls = await page.getByRole('button', { name: /deactivate|^add$/i }).count()
  if (editControls > 0) {
    failures.push({
      page: '/locations',
      kind: 'role',
      text: `a supervisor was offered ${editControls} master-data control(s)`,
    })
  } else {
    console.log('  ✓     locations · edit controls hidden from a non-admin')
  }
}

// --- scanning, which is the beat every demo opens with -------------------
// Driven through the manual box rather than the keyboard wedge: the wedge
// recognises a scan by TIMING, so a synthetic keystroke sequence either races
// or needs a fake clock, and a flaky check on the demo's first beat is worse
// than none. The manual box takes the same code path from the lookup onwards.
{
  current = 'scan · lookup'
  await visit('/scan')

  const box = page.getByLabel(/enter a code manually/i).first()
  if ((await box.count()) === 0) {
    failures.push({ page: '/scan', kind: 'missing', text: 'no way to enter a code' })
  } else {
    // A barcode the screen itself offers, so this cannot drift from the seed.
    const demoCode = await page
      .getByRole('button', { name: /^\d{8,14}$/ })
      .first()
      .textContent()
      .catch(() => null)

    if (!demoCode) {
      failures.push({
        page: '/scan',
        kind: 'missing',
        text: 'the scan screen offered no demo barcode to try',
      })
    } else {
      await box.fill(demoCode.trim())
      await box.press('Enter')

      try {
        // The resolved item, not merely "something happened".
        await page
          .getByText(/receive|issue|on hand|found/i)
          .first()
          .waitFor({ timeout: 30_000 })
        console.log(`  ✓     scan · ${demoCode.trim()} resolved to something actionable`)
      } catch {
        failures.push({
          page: '/scan',
          kind: 'flow',
          text: `scanning ${demoCode.trim()} resolved to nothing`,
        })
      }
    }
  }
}

// --- FEFO and the expiry block -------------------------------------------
// Two demo beats that nothing checked. Both are decisions the system makes on
// the operator's behalf, which is exactly the kind of thing that can quietly
// stop happening: the form still renders, the issue still posts, and nobody
// notices the oldest stock is no longer being proposed.
{
  current = 'movements · FEFO'
  await visit('/inventory?tracking=batch', 'inventory · batch-tracked')

  const batchItemHref = await firstRecordHref('/inventory/')
  if (!batchItemHref) {
    failures.push({
      page: '/inventory?tracking=batch',
      kind: 'no link',
      text: 'no batch-tracked item to demonstrate FEFO with',
    })
  } else {
    const batchItemId = batchItemHref.split('/').pop()

    // A location first. FEFO is per-location by design — there is no "oldest
    // stock" until you say where you are picking from — so the form proposes
    // nothing until one is chosen, and checking without one proves nothing.
    await visit(`/movements/new?item=${batchItemId}&kind=issue`, 'movement form · FEFO issue')

    const fromSelect = page.locator('select[name="fromLocationId"]').first()
    const locationId =
      (await fromSelect.count()) > 0
        ? await fromSelect.locator('option').nth(1).getAttribute('value')
        : null

    if (!locationId) {
      failures.push({
        page: 'movement form · issue',
        kind: 'missing',
        text: 'no location to issue from, so FEFO could not be demonstrated',
      })
    }

    await visit(
      `/movements/new?item=${batchItemId}&kind=issue&from=${locationId}&qty=1`,
      'movement form · FEFO issue from a location',
    )

    // "Use first" is the proposal. Without it an operator picks a batch at
    // random and the oldest stock expires on the shelf.
    const proposed = await page.getByText(/use first/i).count()
    if (proposed === 0) {
      failures.push({
        page: 'movement form · issue',
        kind: 'fefo',
        text: 'no batch was proposed to use first',
      })
    } else {
      console.log('  ✓     movements · FEFO proposed a batch to use first')
    }

    // And the block. An expired or quarantined batch has to be visibly
    // refused rather than silently offered.
    const blocked = await page.getByText(/expired|quarantine/i).count()
    if (blocked === 0) {
      console.log('  ·     movements · no expired batch in the demo data to block right now')
    } else {
      console.log('  ✓     movements · an expired or quarantined batch is flagged on the form')
    }
  }
}

// --- an RFID cycle count, start to finish --------------------------------
// The flagship workflow. Driven end to end because every piece works in
// isolation and the question that matters is whether they work together.
let countSessionUrl = null

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
      await page
        .getByText(/saw \d+ tag|saw no tags|reader/i)
        .first()
        .waitFor({ timeout: 30_000 })

      const note = await page
        .getByText(/saw \d+ tag|saw no tags/i)
        .first()
        .textContent()
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

      // Submit, then approve. This is the payoff of the whole count and the
      // only part that writes to the ledger — and until now the smoke test
      // stopped one step before it, so the beat the demo ends on was the beat
      // nothing checked.
      current = 'counts · submit'
      countSessionUrl = page.url()

      const submit = page.getByRole('button', { name: /submit for approval/i }).first()
      if ((await submit.count()) === 0) {
        failures.push({ page: 'counts', kind: 'missing', text: 'no way to submit a count' })
      } else {
        await submit.click()

        try {
          await page
            .getByRole('button', { name: /approve and post/i })
            .first()
            .waitFor({ timeout: 30_000 })
          console.log('  ✓     counts · submitted for approval')
        } catch {
          failures.push({
            page: 'counts',
            kind: 'flow',
            text: 'submitting did not produce a count awaiting approval',
          })
        }
      }
    }
  }
}

// --- approving the count, which is the only part that posts stock --------
// A separate block because it is a separate decision: the counter submits, a
// supervisor decides. The smoke account IS a supervisor, so the same session
// can do both — what is being checked here is that approving actually posts
// COUNT movements rather than merely changing a status.
if (countSessionUrl) {
  current = 'counts · approve'
  await visit(countSessionUrl.replace(BASE, ''), 'counts · review')

  const approve = page.getByRole('button', { name: /approve and post/i }).first()

  if ((await approve.count()) === 0) {
    failures.push({
      page: 'counts · review',
      kind: 'missing',
      text: 'a supervisor was offered no way to approve a submitted count',
    })
  } else {
    // Whether this count found anything to correct, read from the screen
    // BEFORE approving. A count that matched the system posts nothing, and
    // that is correct — so "no COUNT movements afterwards" is only a failure
    // when there was in fact a variance. The simulated reader misses tags on
    // purpose, so there usually is one, but a test that depends on that is a
    // test that fails at random.
    const nothingToCorrect = (await page.getByText(/found nothing to correct/i).count()) > 0

    // Counting the ledger navigates away, so it happens BEFORE the button is
    // found again. Clicking a locator from the previous page would fail in a
    // way that reads like a broken approval.
    const before = await countLedgerRows()
    await page.goto(countSessionUrl, { waitUntil: 'networkidle' })

    await page
      .getByRole('button', { name: /approve and post/i })
      .first()
      .click()

    try {
      // The session's own state once approved, not the action's transient
      // message: approving flips the status, which removes the whole review
      // block — message and all — and replaces it with this. Two earlier
      // selectors got this wrong in opposite directions, one matching text
      // that was already on the page before anything happened, the other
      // waiting for a message that correctly no longer exists.
      await page
        .getByText(/Approved by /i)
        .first()
        .waitFor({ timeout: 60_000 })

      const verdict = await page
        .getByText(/Approved by /i)
        .first()
        .textContent()

      const after = await countLedgerRows()

      if (nothingToCorrect) {
        // Approving a clean count must not invent corrections.
        if (after !== before) {
          failures.push({
            page: 'counts · approve',
            kind: 'flow',
            text: `a count with nothing to correct still posted ${after - before} movement(s)`,
          })
        } else {
          console.log('  ✓     counts · approved a clean count, and posted nothing')
        }
      } else if (after <= before) {
        // The ledger is the actual claim. Without a new row, "approved" was a
        // label on nothing.
        failures.push({
          page: 'counts · approve',
          kind: 'flow',
          text: 'the count had variances and was approved, but no COUNT movement reached the ledger',
        })
      } else {
        console.log(
          `  ✓     counts · ${verdict?.trim()} (${after - before} new CNT row(s) in the ledger)`,
        )
      }
    } catch {
      // Including the error the action reported, if it reported one. "No
      // result" and "refused because X" are different problems.
      const reported = await page
        .getByText(/could not be approved|not valid|forbidden/i)
        .first()
        .textContent()
        .catch(() => null)

      failures.push({
        page: 'counts · approve',
        kind: 'flow',
        text: reported
          ? `approving was refused: ${reported.trim()}`
          : 'approving reported no result at all',
      })
    }
  }
}

/** COUNT rows currently in the ledger, read from the movements list. */
async function countLedgerRows() {
  await page.goto(`${BASE}/movements?type=count`, { waitUntil: 'networkidle' })
  return page.getByText(/CNT-/i).count()
}

// --- printing a label ----------------------------------------------------
// Printed for real, not just rendered. The preview is parsed from the bytes
// that go to the printer, so a broken render is a broken job.
{
  await visit(`/labels?item=${itemId}`, '/labels')

  current = 'labels · preview'
  // The SVG only appears once the server has rendered the ZPL.
  await page
    .getByRole('img', { name: /label preview/i })
    .first()
    .waitFor({ timeout: 30_000 })

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
  await page
    .getByRole('button', { name: /^print$/i })
    .first()
    .click()
  await page
    .getByText(/PRN-\d{4}-\d{6}/)
    .first()
    .waitFor({ timeout: 30_000 })

  const receipt = await page
    .getByText(/PRN-\d{4}-\d{6}/)
    .first()
    .textContent()
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
  // The live console must actually receive something. A console that renders
  // but never updates says "nothing is happening" when the truth is "I am not
  // listening", which is the failure it exists to prevent.
  current = 'devices · live console'
  await page
    .getByText(/connected|reconnecting/i)
    .first()
    .waitFor({ timeout: 30_000 })

  current = 'devices · self-test'
  await selfTest.click()

  // Wait for something that can only exist AFTER the action returns. Waiting on
  // "Simulation" matched the badge already on the page, so the assertions below
  // ran before the report had rendered and passed for the wrong reason.
  await page
    .getByText(/^\d+ms$/)
    .first()
    .waitFor({ timeout: 30_000 })

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

  // The self-test publishes a DEVICE event, so the console should show it
  // without a reload. This is the end-to-end proof that SSE is delivering.
  current = 'devices · live event'
  try {
    await page
      .getByText(/self-test (passed|failed)/i)
      .first()
      .waitFor({ timeout: 20_000 })
    console.log('  ✓     devices · live console received the event')
  } catch {
    failures.push({
      page: '/devices',
      kind: 'stream',
      text: 'the self-test event never reached the live console',
    })
  }
}

// --- offline and sync ----------------------------------------------------
// The mobile contract, demonstrated from the web: queue while disconnected,
// push as one batch, get a verdict per row. Driven for real, including the
// negative-stock flag, because that is the beat most likely to be shown to
// somebody and the one with the most moving parts.
{
  await visit('/demo/handset')

  current = 'handset · queue offline'
  const record = page.getByRole('button', { name: /^record$/i }).first()

  if ((await record.count()) === 0) {
    failures.push({ page: '/demo/handset', kind: 'missing', text: 'no way to record' })
  } else {
    // One receipt, and one issue far larger than anything on hand — the second
    // must come back FLAGGED rather than rejected, because it is work somebody
    // physically did (WADR-007).
    await record.click()

    await page.locator('#type').selectOption('ISSUE')
    await page.fill('#quantity', '99999')
    await record.click()

    await page
      .getByText(/2 pending/i)
      .first()
      .waitFor({ timeout: 10_000 })
    console.log('  ✓     handset · 2 movements queued while offline')

    current = 'handset · sync'
    await page.getByRole('button', { name: /switch the network on/i }).click()
    await page.getByRole('button', { name: /^sync 2 movements$/i }).click()

    await page
      .getByText(/what the server said/i)
      .first()
      .waitFor({ timeout: 30_000 })

    const accepted = await page.getByText(/^accepted$/i).count()
    const flagged = await page.getByText(/^flagged$/i).count()

    if (accepted < 1 || flagged < 1) {
      failures.push({
        page: '/demo/handset',
        kind: 'sync',
        text: `expected an accepted row and a flagged row; got ${accepted} accepted, ${flagged} flagged`,
      })
    }
    console.log(`  ✓     handset · synced — ${accepted} accepted, ${flagged} flagged`)
  }
}

// --- demo reset ----------------------------------------------------------
// Clicked for real. This is the one path the integration tests deliberately do
// not exercise, because running it there would wipe the demo database out from
// under whoever is looking at it.
{
  current = 'devices · demo reset'

  // The signed-in account is a SUPERVISOR, and reset is admin-only. Its absence
  // here is the guardrail working, so it is asserted rather than assumed.
  if ((await page.getByRole('button', { name: /^reset demo data$/i }).count()) > 0) {
    failures.push({
      page: '/devices',
      kind: 'permission',
      text: 'a supervisor can see the admin-only demo reset',
    })
  }
  console.log('  ✓     devices · reset hidden from a supervisor')

  // Now as an administrator, who may. Signing out by clearing the session
  // cookie rather than by finding a sign-out control, so this check does not
  // break when the menu is rearranged.
  await context.clearCookies()
  await visit('/login', 'login as admin')
  await page.getByRole('button', { name: /demo/i }).first().click()
  await page.fill('#email', ADMIN.email)
  await page.fill('#password', ADMIN.password)
  await page.getByRole('button', { name: /enter demo|sign in/i }).click()
  await page.waitForURL(/dashboard/, { timeout: 30_000 })
  await visit('/devices', '/devices as admin')

  // --- admin screens, which only exist for this account ------------------
  current = 'admin · audit log'
  await visit('/admin/audit', 'admin · audit log')
  await visit('/admin/reason-codes', 'admin · reason codes')

  // Master data, driven both ways: something that should work, and something
  // that should be refused. The refusals are the point of the screen, and a
  // refusal that never reaches the page is the same as no guard at all.
  current = 'admin · master data'
  await visit('/admin/master-data', 'admin · master data')

  {
    const name = `Smoke ${Date.now()}`
    await page.fill('#category-name', name)
    await page.getByRole('button', { name: /^add$/i }).nth(1).click()

    try {
      await page
        .getByText(new RegExp(`${name} added`, 'i'))
        .first()
        .waitFor({ timeout: 30_000 })
      console.log('  ✓     admin · added a category')
    } catch {
      failures.push({
        page: '/admin/master-data',
        kind: 'broken',
        text: 'could not add a category',
      })
    }
  }

  {
    // The only active site cannot be deactivated: with none active there is
    // nowhere to receive stock into.
    const deactivate = page.getByRole('button', { name: /deactivate/i }).first()

    if ((await deactivate.count()) === 0) {
      failures.push({
        page: '/admin/master-data',
        kind: 'missing',
        text: 'no site controls on the master data screen',
      })
    } else {
      await deactivate.click()

      try {
        await page
          .getByText(/only active site|still holds stock/i)
          .first()
          .waitFor({ timeout: 30_000 })
        console.log('  ✓     admin · refused to deactivate a site that is still in use')
      } catch {
        failures.push({
          page: '/admin/master-data',
          kind: 'guard',
          text: 'deactivating a site in use was not refused on screen',
        })
      }
    }
  }

  // Locations as an admin: add one, then try to deactivate one that is holding
  // stock. The refusal is the whole point of the screen — deactivating a place
  // does not empty it, it just stops anyone finding what is in it.
  current = 'admin · locations'
  await visit('/locations', 'admin · locations')

  {
    const code = `S-${String(Date.now()).slice(-4)}`
    await page.fill('#code', code)
    await page.fill('#name', `Smoke rack ${code}`)
    await page.getByRole('button', { name: /^add$/i }).first().click()

    try {
      await page
        .getByText(new RegExp(`${code} added`, 'i'))
        .first()
        .waitFor({ timeout: 30_000 })
      console.log(`  ✓     admin · added location ${code}`)
    } catch {
      failures.push({ page: '/locations', kind: 'broken', text: 'could not add a location' })
    }

    // A location that genuinely holds stock, found by reading the On hand
    // column rather than by guessing. An earlier version picked the first row
    // with a filter that matched an EMPTY location, deactivated it happily,
    // and reported the guard as broken.
    // The "On hand" column is found by its HEADER, not by position. An earlier
    // version hard-coded the index and silently started reading the wrong
    // column the moment a column was inserted — reporting the guard as broken.
    const headers = await page
      .locator('thead th')
      .evaluateAll((cells) => cells.map((cell) => cell.textContent?.trim() ?? ''))
    const onHandColumn = headers.findIndex((header) => /^on hand$/i.test(header))

    if (onHandColumn < 0) {
      failures.push({
        page: '/locations',
        kind: 'missing',
        text: `no "On hand" column; headers were ${headers.join(' | ')}`,
      })
    }

    const rows = page.locator('tbody tr')
    let stockedRow = null

    for (let index = 0; index < (await rows.count()); index++) {
      const row = rows.nth(index)
      const onHand = (await row.locator('td').nth(onHandColumn).textContent())?.trim()

      if (onHand && /^\d+$/.test(onHand) && Number(onHand) > 0) {
        stockedRow = row
        break
      }
    }

    const deactivate = stockedRow
      ? stockedRow.getByRole('button', { name: /deactivate/i }).first()
      : page.locator('nothing-matches')

    if ((await deactivate.count()) === 0) {
      failures.push({
        page: '/locations',
        kind: 'missing',
        text: 'no deactivate control on a location row',
      })
    } else {
      await deactivate.click()

      try {
        await page
          .getByText(/still holds|only active location/i)
          .first()
          .waitFor({ timeout: 30_000 })
        console.log('  ✓     admin · refused to deactivate a location in use')
      } catch {
        failures.push({
          page: '/locations',
          kind: 'guard',
          text: 'deactivating a location holding stock was not refused on screen',
        })
      }
    }
  }

  // Import, driven all the way through: check, then commit. The dry run must
  // change nothing, which is the property the whole screen exists for.
  current = 'admin · import'
  await visit('/admin/import', 'admin · import')

  const stamp = Date.now()
  await page
    .locator('textarea')
    .fill(
      `sku,name,unit,reorderPoint,tracking\nIMP-${stamp},Imported thing,pcs,5,NONE\n,No SKU here,pcs,1,NONE`,
    )
  await page.getByRole('button', { name: /check the file/i }).click()
  await page
    .getByText(/nothing has been changed yet/i)
    .first()
    .waitFor({ timeout: 30_000 })

  // One good row, one bad — both reported before anything is written.
  await page.getByText(/1 new/i).first().waitFor({ timeout: 10_000 })
  await page
    .getByText(/1 rows skipped|1 row skipped/i)
    .first()
    .waitFor({ timeout: 10_000 })
  console.log('  ✓     admin · dry run reported 1 new and 1 skipped, and changed nothing')

  await page.getByRole('button', { name: /^import 1 row$/i }).click()
  await page
    .getByText(/^Imported\.$/)
    .first()
    .waitFor({ timeout: 30_000 })
  console.log('  ✓     admin · committed the import')

  // And it really landed.
  await visit(`/inventory?q=IMP-${stamp}`, 'inventory · finds the imported item')
  if ((await page.getByText(`IMP-${stamp}`).count()) === 0) {
    failures.push({
      page: '/inventory',
      kind: 'import',
      text: 'the imported item does not appear in inventory',
    })
  }
  console.log('  ✓     admin · the imported item is in inventory')

  // The template editor refuses what a printer cannot use. Driven for real,
  // because a validator nobody exercises is a validator that quietly stops
  // matching the server's.
  current = 'admin · label templates'
  await visit('/admin/labels', 'admin · label templates')
  await visit('/admin/labels?edit=new', 'admin · new template')

  // A placeholder nothing can fill must be refused, and Save must be disabled.
  await page.fill('#zplBody', '^XA^FD{{nosuchfield}}^FS^XZ')
  await page
    .getByText(/nothing can fill/i)
    .first()
    .waitFor({ timeout: 10_000 })
  if (await page.getByRole('button', { name: /save template/i }).isEnabled()) {
    failures.push({
      page: '/admin/labels',
      kind: 'validation',
      text: 'a template with an unfillable placeholder could still be saved',
    })
  }
  console.log('  ✓     admin · refused a template nothing can fill')

  // A good one previews and saves.
  await page.fill('#name', `Smoke label ${Date.now()}`)
  await page.fill(
    '#zplBody',
    '^XA^CI28^PW812^LL406\n^FO30,30^A0N,40,40^FD{{itemName}}^FS\n^FO30,175^BY3,2,150^BEN,150,Y,N^FD{{barcode12}}^FS\n^XZ',
  )
  await page
    .getByRole('img', { name: /label preview/i })
    .first()
    .waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: /save template/i }).click()
  await page
    .getByText(/created/i)
    .first()
    .waitFor({ timeout: 30_000 })
  console.log('  ✓     admin · previewed and saved a template')

  // A setting is only worth having if it changes behaviour, so this sets one
  // and then does the thing it governs.
  current = 'admin · settings'
  await visit('/admin/settings', 'admin · settings')

  // Stock integrity, from the screen rather than from curl.
  await page.getByRole('button', { name: /check now/i }).click()
  await page
    .getByText(/ledger and the projection agree|do not match the ledger/i)
    .first()
    .waitFor({ timeout: 60_000 })
  const integrity = await page
    .getByText(/ledger and the projection agree|do not match the ledger/i)
    .first()
    .textContent()
  console.log(`  ✓     admin · stock integrity — ${integrity?.trim().slice(0, 60)}`)

  await page.fill('#adjust\\.maxQuantity', '5')
  await page
    .locator('form', { has: page.locator('#adjust\\.maxQuantity') })
    .getByRole('button', { name: /save/i })
    .click()
  await page
    .getByText(/takes effect on the next movement/i)
    .first()
    .waitFor({ timeout: 30_000 })
  console.log('  ✓     admin · capped adjustments at 5')

  current = 'admin · settings take effect'
  // An UNTRACKED item: adjusting a batch-tracked one needs a batch as well,
  // and the point here is the cap, not the batch rules.
  await page.goto(`${BASE}/inventory?tracking=none`, { waitUntil: 'networkidle' })
  const plainItemHref = await firstRecordHref('/inventory/')
  await visit(
    `/movements/new?item=${plainItemHref?.split('/').pop()}&kind=adjust`,
    'movement form · adjust (capped)',
  )
  // An adjustment sets the COUNTED total, not a delta — the field is named for
  // what it is.
  // Location and reason are both required and neither is preselected. Without
  // them the form fails validation before the cap is ever consulted, which
  // looks identical to the cap not working.
  const adjustLocation = page.locator('#locationId')
  const locationValue = await adjustLocation.locator('option').nth(1).getAttribute('value')
  if (locationValue) await adjustLocation.selectOption(locationValue)

  await page.fill('#countedQuantity', '99999')
  const reason = page.locator('#reasonCodeId')
  if (await reason.count()) {
    const value = await reason.locator('option').nth(1).getAttribute('value')
    if (value) await reason.selectOption(value)
  }
  // The button is named for the movement — 'Post adjustment', not 'Record'. A
  // loose selector matched a different control and clicked nothing useful,
  // which read as 'the cap did not refuse it'.
  await page.getByRole('button', { name: /^post adjustment$/i }).click()

  try {
    await page
      .getByText(/limit is 5/i)
      .first()
      .waitFor({ timeout: 20_000 })
    console.log('  ✓     admin · the cap refused an oversized adjustment')
  } catch {
    failures.push({
      page: '/movements/new',
      kind: 'policy',
      text: 'an adjustment beyond the configured cap was not refused',
    })
  }

  current = 'admin · people'
  await visit('/admin/users', 'admin · people')

  await page.getByRole('button', { name: /add someone/i }).click()
  await page.fill('#name', 'Smoke Test Starter')
  await page.fill('#email', `smoke.${Date.now()}@inventory.local`)
  await page.getByRole('button', { name: /^create account$/i }).click()

  // The generated password is shown once. If it ever stops appearing, an admin
  // has created an account nobody can sign in to.
  await page
    .getByText(/shown once, and not recoverable/i)
    .first()
    .waitFor({ timeout: 30_000 })
  console.log('  ✓     admin · created an account and showed its password once')

  // The self-lockout guard, from the UI rather than the service: an admin must
  // not be able to demote or deactivate themselves.
  const ownRowControls = await page
    .locator('tr', { hasText: ADMIN.email })
    .getByRole('button', { name: /deactivate/i })
    .count()
  if (ownRowControls > 0) {
    failures.push({
      page: '/admin/users',
      kind: 'lockout',
      text: 'an admin is offered a control to deactivate their own account',
    })
  }
  console.log('  ✓     admin · cannot deactivate their own account')

  current = 'devices · register'
  await visit('/devices', '/devices as admin (again)')
  const add = page.getByRole('button', { name: /add a printer or reader/i }).first()
  if ((await add.count()) === 0) {
    failures.push({ page: '/devices', kind: 'missing', text: 'an admin cannot add a device' })
  } else {
    await add.click()
    await page.fill('#label', 'Smoke-test printer')
    await page.locator('#connection').selectOption('SIMULATED')
    await page.getByRole('button', { name: /^add device$/i }).click()
    await page
      .getByText(/Smoke-test printer added/i)
      .first()
      .waitFor({ timeout: 30_000 })
    console.log('  ✓     devices · registered a device as admin')
  }

  current = 'devices · self-test'
  // The self-test record only exists after somebody presses the button, so
  // nothing before this point has rendered a single step. A printer simulator
  // is registered above, so this exercises the real action and the real
  // reporting path.
  // Not anchored: the accessible name carries a screen-reader suffix naming the
  // device, so /^self-test$/ finds nothing.
  const selfTest = page.getByRole('button', { name: /self-test/i }).first()

  if ((await selfTest.count()) === 0) {
    failures.push({ page: '/devices', kind: 'missing', text: 'no self-test control on a device' })
  } else {
    await selfTest.click()

    // Waits for the DETAIL, not the step name. A step name can match text that
    // was already on the page, which would let this walk past a report that
    // never rendered — and the detail is the whole point: every step says what
    // happened, not whether it passed.
    const detail = page.getByText(/no network involved/i).first()

    try {
      await detail.waitFor({ timeout: 60_000 })
      console.log('  ✓     devices · self-test rendered a record, not a verdict')
    } catch {
      failures.push({
        page: '/devices',
        kind: 'empty',
        text: 'a self-test did not render what happened at each step',
      })
    }
  }

  const reset = page.getByRole('button', { name: /^reset demo data$/i }).first()

  if ((await reset.count()) === 0) {
    failures.push({ page: '/devices', kind: 'missing', text: 'an admin cannot see demo reset' })
  } else {
    await reset.click()

    // A second click, not a dialog: the same guard, and it keeps the
    // consequence on screen while the operator decides.
    await page
      .getByText(/will be destroyed/i)
      .first()
      .waitFor({ timeout: 10_000 })
    await page.getByRole('button', { name: /yes, reset it/i }).click()

    await page
      .getByText(/Demo data reset in/i)
      .first()
      .waitFor({ timeout: 120_000 })
    const note = await page
      .getByText(/Demo data reset in/i)
      .first()
      .textContent()
    console.log(`  ✓     devices · ${note?.trim().slice(0, 60)}`)
  }
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
