/**
 * Exercises /api/v1 over HTTP, the way the mobile client will.
 *
 * The integration tests call the sync SERVICES directly; this calls the
 * ENDPOINTS. The difference is not academic — it caught the session middleware
 * redirecting /api/v1 to the login page, so every unauthenticated API call came
 * back 200 with HTML. A client would have read that as success.
 *
 * Usage:  npm run check:api [baseUrl]
 * Assumes a server is running and the demo database is seeded.
 */

const BASE = (process.argv[2] ?? 'http://localhost:3000') + '/api/v1'
const DEVICE_ID = crypto.randomUUID()

const log = (label, value) => console.log(`  ${label.padEnd(38)} ${value}`)

async function call(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  })
  const body = await response.json().catch(() => null)
  return { status: response.status, body, headers: response.headers }
}

console.log('=== health ===')
{
  const { status, body } = await call('/health')
  log('GET /health', `${status} ${body?.status}`)
}

console.log('\n=== auth ===')
{
  const bad = await call('/auth/token', {
    method: 'POST',
    body: JSON.stringify({ email: 'nobody@inventory.local', password: 'wrong', mode: 'DEMO' }),
  })
  log('wrong credentials', `${bad.status} ${bad.body?.error?.code}`)
  log('  message is not enumerable', JSON.stringify(bad.body?.error?.message?.slice(0, 44)))
}

const signIn = await call('/auth/token', {
  method: 'POST',
  body: JSON.stringify({
    email: 'operator@inventory.local',
    password: 'demo1234',
    mode: 'DEMO',
    device: { id: DEVICE_ID, label: 'Test handset', platform: 'ANDROID', appVersion: '1.0.0' },
  }),
})
log('POST /auth/token', signIn.status)
log('  role', signIn.body?.user?.role)
log('  mode claim', signIn.body?.mode)
log('  sites', signIn.body?.sites?.length)
log('  access token expires in', `${signIn.body?.expiresIn}s`)

const auth = (token) => ({ Authorization: `Bearer ${token}` })
let { accessToken, refreshToken } = signIn.body

console.log('\n=== auth guards ===')
{
  const none = await call('/sync/pull')
  log('no token', `${none.status} ${none.body?.error?.code}`)

  const junk = await call('/sync/pull', { headers: auth('not.a.jwt') })
  log('malformed token', `${junk.status} ${junk.body?.error?.code}`)

  const ok = await call('/sync/pull', { headers: auth(accessToken) })
  log('valid token', `${ok.status}`)
  log('  X-App-Mode echoed', ok.headers.get('x-app-mode'))
  log('  X-Request-Id present', Boolean(ok.headers.get('x-request-id')))
}

console.log('\n=== pull ===')
let cursor
{
  const { body } = await call('/sync/pull', { headers: auth(accessToken) })
  cursor = body.nextCursor
  log('items', body.items?.length)
  log('locations', body.locations?.length)
  log('batches', body.batches?.length)
  log('serial units', body.serialUnits?.length)
  log('stock levels', body.stockLevels?.length)
  log('reason codes', body.reasonCodes?.length)
  log('cursor issued', Boolean(cursor))
  log(
    'sentinel batch sent as null',
    body.stockLevels?.some((l) => l.batchId === null),
  )

  // Every entity, not just items. Checking items alone is what let a cursor bug
  // hide: stock levels came back on every single pull, for ever, and no
  // assertion here ever looked at them.
  const again = await call(`/sync/pull?since=${encodeURIComponent(cursor)}`, {
    headers: auth(accessToken),
  })
  const entities = ['items', 'locations', 'batches', 'serialUnits', 'stockLevels', 'reasonCodes']
  const stillSending = entities.filter((entity) => (again.body[entity]?.length ?? 0) > 0)
  log('second pull returns nothing new', stillSending.length === 0 || stillSending.join(', '))
  log('  and does not claim more pages', again.body.hasMore === false)

  const bogus = await call('/sync/pull?since=garbage', { headers: auth(accessToken) })
  log('invented cursor refused', `${bogus.status} ${bogus.body?.error?.code}`)
}

console.log('\n=== push ===')
{
  const pulled = await call('/sync/pull', { headers: auth(accessToken) })
  const item = pulled.body.items.find((i) => i.trackingMode === 'NONE')
  const location = pulled.body.locations[1]
  const siteId = signIn.body.sites[0].id

  const id = crypto.randomUUID()
  const outbox = {
    movements: [
      {
        id,
        itemId: item.id,
        type: 'RECEIVE',
        quantity: 9,
        toLocationId: location.id,
        occurredAt: new Date().toISOString(),
        siteId,
      },
    ],
  }

  const first = await call('/sync/push', {
    method: 'POST',
    headers: auth(accessToken),
    body: JSON.stringify(outbox),
  })
  log('POST /sync/push', first.status)
  log('  verdict', first.body.results[0]?.status)
  log('  document number', first.body.results[0]?.docNo)

  const replay = await call('/sync/push', {
    method: 'POST',
    headers: auth(accessToken),
    body: JSON.stringify(outbox),
  })
  log('replayed push', replay.body.results[0]?.status)

  const malformed = await call('/sync/push', {
    method: 'POST',
    headers: auth(accessToken),
    body: JSON.stringify({ movements: [{ id: 'not-a-uuid', type: 'NONSENSE' }] }),
  })
  log('malformed body', `${malformed.status} ${malformed.body?.error?.code}`)
  log('  names the field', JSON.stringify(malformed.body?.error?.details?.fields?.[0]?.field))
}

console.log('\n=== EPC allocation ===')
{
  const pulled = await call('/sync/pull', { headers: auth(accessToken) })
  const item = pulled.body.items.find((i) => i.barcodes?.some((b) => b.type === 'EAN13'))

  const first = await call('/epc/allocate', {
    method: 'POST',
    headers: auth(accessToken),
    body: JSON.stringify({ itemId: item.id, count: 50 }),
  })
  log('POST /epc/allocate', first.status)
  log('  block', `${first.body?.serialFrom}..${first.body?.serialTo}`)
  log('  sample EPC', first.body?.sampleEpc)
  log('  EPC is 24 hex', /^[0-9A-F]{24}$/i.test(first.body?.sampleEpc ?? ''))

  const second = await call('/epc/allocate', {
    method: 'POST',
    headers: auth(accessToken),
    body: JSON.stringify({ itemId: item.id, count: 50 }),
  })
  log('second block starts after the first', second.body?.serialFrom === first.body?.serialTo + 1)

  // The same property the integration test proves against the service, now over
  // HTTP: six handsets asking at once must not receive overlapping serials.
  const racers = await Promise.all(
    Array.from({ length: 6 }, () =>
      call('/epc/allocate', {
        method: 'POST',
        headers: auth(accessToken),
        body: JSON.stringify({ itemId: item.id, count: 20 }),
      }),
    ),
  )
  const ranges = racers.map((r) => r.body).sort((a, b) => a.serialFrom - b.serialFrom)
  const overlapping = ranges.some((r, i) => i > 0 && r.serialFrom <= ranges[i - 1].serialTo)
  log('6 concurrent requests overlap', overlapping)

  const tooMany = await call('/epc/allocate', {
    method: 'POST',
    headers: auth(accessToken),
    body: JSON.stringify({ itemId: item.id, count: 999_999 }),
  })
  log('absurd count refused', `${tooMany.status} ${tooMany.body?.error?.code}`)

  const unknown = await call('/epc/allocate', {
    method: 'POST',
    headers: auth(accessToken),
    body: JSON.stringify({ itemId: crypto.randomUUID(), count: 10 }),
  })
  log('unknown item', `${unknown.status} ${unknown.body?.error?.code}`)
}

console.log('\n=== device heartbeat ===')
{
  const beat = await call('/devices/heartbeat', {
    method: 'POST',
    headers: auth(accessToken),
    body: JSON.stringify({ appVersion: '1.0.1', pendingCount: 4, batteryPercent: 61 }),
  })
  log('POST /devices/heartbeat', beat.status)
  log('  device recognised', beat.body?.deviceId === DEVICE_ID)
  log('  pending reported back', beat.body?.pendingCount)
}

console.log('\n=== registers ===')
{
  const batches = await call('/batches', { headers: auth(accessToken) })
  log('GET /batches', batches.status)
  log('  batches', batches.body?.batches?.length)
  log('  expiry summary present', Boolean(batches.body?.summary?.expired))
  log('  on hand computed server-side', typeof batches.body?.batches?.[0]?.onHand === 'number')

  const expired = await call('/batches?expiry=EXPIRED', { headers: auth(accessToken) })
  log('filtered to expired', expired.body?.batches?.every((b) => b.expiryState === 'EXPIRED'))

  const units = await call('/serials?limit=5', { headers: auth(accessToken) })
  log('GET /serials?limit=5', `${units.status} ${units.body?.units?.length} unit(s)`)

  // An EPC must match exactly — a partial match resolving to the wrong unit is
  // worse than no match at all.
  const tagged = units.body?.units?.find((u) => u.epc)
  if (tagged) {
    const byTag = await call(`/serials?q=${tagged.epc}`, { headers: auth(accessToken) })
    log('scanned tag resolves to one unit', byTag.body?.units?.length === 1)
    log('  and it is the right one', byTag.body?.units?.[0]?.id === tagged.id)

    const wrongTag = `${tagged.epc.slice(0, 22)}${tagged.epc.slice(22) === 'FF' ? 'EE' : 'FF'}`
    const miss = await call(`/serials?q=${wrongTag}`, { headers: auth(accessToken) })
    log('a tag we do not hold matches nothing', miss.body?.units?.length === 0)
  }
}

console.log('\n=== traceability ===')
{
  const pulled = await call('/sync/pull', { headers: auth(accessToken) })
  const batchId = pulled.body.batches?.[0]?.id
  const unitId = pulled.body.serialUnits?.[0]?.id

  const trace = await call(`/trace/batch/${batchId}`, { headers: auth(accessToken) })
  log('GET /trace/batch/:id', trace.status)
  log('  batch', trace.body?.batch?.batchNo)
  log('  on hand', trace.body?.batch?.onHand)
  log('  expiry state', trace.body?.batch?.expiryState)
  log('  locations holding it', trace.body?.locations?.length)
  log('  movements', trace.body?.movements?.length)

  const missing = await call(`/trace/batch/${crypto.randomUUID()}`, { headers: auth(accessToken) })
  log('unknown batch', `${missing.status} ${missing.body?.error?.code}`)

  const unit = await call(`/serials/${unitId}/history`, { headers: auth(accessToken) })
  log('GET /serials/:id/history', unit.status)
  log('  serial', unit.body?.unit?.serialNo)
  log('  history entries', unit.body?.history?.length)
  log('  first entry is a receipt', unit.body?.history?.[0]?.type)
}

console.log('\n=== count lifecycle ===')
{
  const pulled = await call('/sync/pull', { headers: auth(accessToken) })
  const siteId = signIn.body.sites[0].id
  // Driven from the stock, not the location list: the first location is a
  // receiving dock that holds nothing, and counting an empty bin proves nothing.
  const level = pulled.body.stockLevels.find((l) => l.quantity > 1)
  const location = pulled.body.locations.find((l) => l.id === level.locationId)

  const sessionId = crypto.randomUUID()
  const start = await call('/counts', {
    method: 'POST',
    headers: auth(accessToken),
    body: JSON.stringify({ id: sessionId, siteId, locationId: location.id, method: 'MANUAL' }),
  })
  log('POST /counts', `${start.status} ${start.body?.docNo}`)

  const retried = await call('/counts', {
    method: 'POST',
    headers: auth(accessToken),
    body: JSON.stringify({ id: sessionId, siteId, locationId: location.id, method: 'MANUAL' }),
  })
  log('retried start is idempotent', retried.body?.docNo === start.body?.docNo)

  // A count is BLIND over the whole location, so a partial submission proposes
  // writing off everything it omits. Counting the whole bin, one line short.
  const atLocation = pulled.body.stockLevels.filter(
    (l) => l.locationId === location.id && l.quantity > 0,
  )
  const submitted = await call(`/counts/${sessionId}/submit`, {
    method: 'POST',
    headers: auth(accessToken),
    body: JSON.stringify({
      counted: atLocation.map((l) => ({
        itemId: l.itemId,
        batchId: l.batchId,
        quantity: l.itemId === level.itemId && l.batchId === level.batchId
          ? l.quantity - 1
          : l.quantity,
      })),
    }),
  })
  log('POST /counts/:id/submit', submitted.status)
  log('  status', submitted.body?.status)
  log('  says nothing has changed yet', JSON.stringify(submitted.body?.message?.slice(0, 26)))
  log('  lines reconciled', submitted.body?.summary?.lines?.length)
  log('  short / over / missing', [
    submitted.body?.summary?.short,
    submitted.body?.summary?.over,
    submitted.body?.summary?.missing,
  ].join(' / '))
  log('  net units', submitted.body?.summary?.netUnits)

  // WADR-008: submitting must not touch stock. If this number moved, approval
  // is decorative and the supervisor gate means nothing.
  const afterSubmit = await call('/sync/pull', { headers: auth(accessToken) })
  const stillThere = afterSubmit.body.stockLevels.find(
    (l) => l.itemId === level.itemId && l.locationId === level.locationId,
  )
  log('stock unchanged by submit', stillThere?.quantity === level.quantity)

  const refused = await call(`/counts/${sessionId}/approve`, {
    method: 'POST',
    headers: auth(accessToken),
  })
  log('operator approving own count', `${refused.status} ${refused.body?.error?.code}`)

  const supervisor = await call('/auth/token', {
    method: 'POST',
    body: JSON.stringify({
      email: 'supervisor@inventory.local',
      password: 'demo1234',
      mode: 'DEMO',
    }),
  })
  const approved = await call(`/counts/${sessionId}/approve`, {
    method: 'POST',
    headers: auth(supervisor.body.accessToken),
  })
  log('supervisor approving', `${approved.status} ${approved.body?.status}`)
  log('  postings', approved.body?.postings)
  log('  one posting per variance', approved.body?.postings === 1)

  const afterApprove = await call('/sync/pull', { headers: auth(accessToken) })
  const corrected = afterApprove.body.stockLevels.find(
    (l) => l.itemId === level.itemId && l.locationId === level.locationId,
  )
  log('stock corrected by approval', corrected?.quantity === level.quantity - 1)

  const listed = await call('/counts?status=APPROVED', { headers: auth(accessToken) })
  log('GET /counts?status=APPROVED', `${listed.status} ${listed.body?.sessions?.length} session(s)`)

  // And a count that scanned nothing — the shape that would write off the whole
  // bin. It must be reported as missing rather than short, and rejecting it must
  // leave stock exactly where it was.
  const rejectedId = crypto.randomUUID()
  await call('/counts', {
    method: 'POST',
    headers: auth(accessToken),
    body: JSON.stringify({ id: rejectedId, siteId, locationId: location.id, method: 'MANUAL' }),
  })
  const empty = await call(`/counts/${rejectedId}/submit`, {
    method: 'POST',
    headers: auth(accessToken),
    body: JSON.stringify({ counted: [] }),
  })
  log('uncounted bin flagged as missing', empty.body?.summary?.missing === empty.body?.summary?.lines?.length)
  const rejected = await call(`/counts/${rejectedId}/reject`, {
    method: 'POST',
    headers: auth(supervisor.body.accessToken),
    body: JSON.stringify({ note: 'Counted the wrong aisle.' }),
  })
  log('supervisor rejecting', `${rejected.status} ${rejected.body?.status}`)

  const afterReject = await call('/sync/pull', { headers: auth(accessToken) })
  const untouched = afterReject.body.stockLevels.find(
    (l) => l.itemId === level.itemId && l.locationId === level.locationId,
  )
  log('stock untouched by rejection', untouched?.quantity === corrected?.quantity)
}

console.log('\n=== refresh rotation ===')
{
  const rotated = await call('/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken, mode: 'DEMO' }),
  })
  log('POST /auth/refresh', rotated.status)
  log('  new token differs', rotated.body.refreshToken !== refreshToken)

  const replay = await call('/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken, mode: 'DEMO' }),
  })
  log('replaying the used token', `${replay.status} ${replay.body?.error?.code}`)

  // Replay means it leaked, so the whole chain for the device is revoked.
  const afterBreach = await call('/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refreshToken: rotated.body.refreshToken, mode: 'DEMO' }),
  })
  log('successor also revoked', `${afterBreach.status} ${afterBreach.body?.error?.code}`)
}

console.log('\n=== mode isolation ===')
{
  const live = await call('/auth/token', {
    method: 'POST',
    body: JSON.stringify({ email: 'admin@inventory.local', password: 'admin12345', mode: 'LIVE' }),
  })
  log('LIVE sign-in with the live admin', live.status)

  if (live.status === 200) {
    const livePull = await call('/sync/pull', { headers: auth(live.body.accessToken) })
    log('  LIVE pull item count', livePull.body.items?.length)
    log(
      '  DEMO pull item count',
      (await call('/sync/pull', { headers: auth(accessToken) })).body.items?.length,
    )
    log('  databases differ', livePull.body.items?.length !== 25)
  }
}
