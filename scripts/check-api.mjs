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

  const again = await call(`/sync/pull?since=${encodeURIComponent(cursor)}`, {
    headers: auth(accessToken),
  })
  log('second pull returns nothing new', again.body.items?.length === 0)

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
