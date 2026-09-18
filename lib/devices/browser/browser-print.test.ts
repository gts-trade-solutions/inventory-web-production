import { describe, expect, it, vi } from 'vitest'
import { BrowserPrint, BrowserPrintError, endpointsFor } from './browser-print'

/**
 * The Zebra Browser Print client.
 *
 * Whether a real installation behaves this way needs a workstation with the
 * utility on it. What is tested here is the part that would be wrong without
 * one: which endpoint is tried, what an absent utility looks like, and that a
 * 200 is reported as "sent" rather than "printed".
 */

const ok = (body: string) => ({ ok: true, status: 200, text: async () => body })
const refused = (status: number) => ({ ok: false, status, text: async () => '' })
const unreachable = () => Promise.reject(new Error('ECONNREFUSED'))

const AVAILABLE = JSON.stringify({
  printer: [{ uid: 'ZD621-USB', name: 'ZD621', connection: 'usb', deviceType: 'printer' }],
})

describe('choosing an endpoint', () => {
  it('tries HTTPS first from a secure page', () => {
    // A page served over HTTPS cannot call the HTTP endpoint — mixed content.
    // Getting this backwards reports "not installed" on a machine where it is
    // installed and running.
    expect(endpointsFor('https:')[0]).toMatch(/^https:/)
  })

  it('tries HTTP first from an insecure page', () => {
    expect(endpointsFor('http:')[0]).toMatch(/^http:/)
  })

  it('always offers both', () => {
    expect(endpointsFor('https:')).toHaveLength(2)
    expect(endpointsFor('http:')).toHaveLength(2)
  })
})

describe('when the utility is not installed', () => {
  it('reports unavailable rather than throwing', async () => {
    const client = new BrowserPrint({ fetch: unreachable as never, protocol: 'http:' })

    expect(await client.available()).toBe(false)
  })

  it('returns no printers rather than an error', async () => {
    // "No local printers" is the normal state on most machines. An error would
    // make every one of them look broken.
    const client = new BrowserPrint({ fetch: unreachable as never, protocol: 'http:' })

    expect(await client.printers()).toEqual([])
  })

  it('says what to do when asked to print', async () => {
    const client = new BrowserPrint({ fetch: unreachable as never, protocol: 'http:' })

    await expect(client.print('any', '^XA^XZ')).rejects.toThrow(/not running|networked printer/i)
  })
})

describe('when it is installed', () => {
  it('finds it on the second endpoint if the first fails', async () => {
    const tried: string[] = []
    const fetch = vi.fn(async (url: string) => {
      tried.push(url)
      return url.startsWith('http://') ? ok(AVAILABLE) : unreachable()
    })

    const client = new BrowserPrint({ fetch: fetch as never, protocol: 'https:' })

    expect(await client.available()).toBe(true)
    expect(tried[0]).toMatch(/^https:/)
    expect(tried[1]).toMatch(/^http:/)
  })

  it('lists the printers attached to this machine', async () => {
    const client = new BrowserPrint({
      fetch: (async () => ok(AVAILABLE)) as never,
      protocol: 'http:',
    })

    const printers = await client.printers()

    expect(printers).toHaveLength(1)
    expect(printers[0]).toMatchObject({ uid: 'ZD621-USB', name: 'ZD621' })
  })

  it('reads the older response shape too', async () => {
    // The utility has used both `printer` and `device` across versions.
    const body = JSON.stringify({
      device: [{ uid: 'A', name: 'B', connection: 'usb', deviceType: 'printer' }],
    })
    const client = new BrowserPrint({
      fetch: (async () => ok(body)) as never,
      protocol: 'http:',
    })

    expect(await client.printers()).toHaveLength(1)
  })

  it('survives a response that is not JSON', async () => {
    const client = new BrowserPrint({
      fetch: (async () => ok('<html>not json</html>')) as never,
      protocol: 'http:',
    })

    expect(await client.printers()).toEqual([])
  })

  it('sends the ZPL to the chosen printer', async () => {
    const sent: Array<{ url: string; body?: string }> = []
    const fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      sent.push({ url, body: init?.body })
      return ok(AVAILABLE)
    })

    const client = new BrowserPrint({ fetch: fetch as never, protocol: 'http:' })
    const result = await client.print('ZD621-USB', '^XA^FDx^FS^XZ')

    expect(result.sent).toBe(true)
    const write = sent.find((request) => request.url.endsWith('/write'))
    expect(write).toBeDefined()
    expect(JSON.parse(write!.body!)).toEqual({
      device: { uid: 'ZD621-USB' },
      data: '^XA^FDx^FS^XZ',
    })
  })

  it('reports "sent", never "printed"', async () => {
    // Like TCP 9100, a 200 means the utility took the bytes. Claiming a label
    // came out sends somebody looking for one that may not exist.
    const client = new BrowserPrint({
      fetch: (async () => ok(AVAILABLE)) as never,
      protocol: 'http:',
    })

    const result = await client.print('ZD621-USB', '^XA^XZ')

    expect(result).toEqual({ sent: true, bytes: 6 })
    expect(Object.keys(result)).not.toContain('printed')
  })

  it('explains a refusal in terms somebody can act on', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.endsWith('/write') ? refused(503) : ok(AVAILABLE),
    )
    const client = new BrowserPrint({ fetch: fetch as never, protocol: 'http:' })

    await expect(client.print('ZD621-USB', '^XA^XZ')).rejects.toThrow(/switched on|selected/i)
  })

  it('probes once and remembers, until told to forget', async () => {
    // The print screen re-checks whenever the picker opens. Probing two
    // endpoints every time adds a visible pause on the machines where the
    // first one is refused.
    const fetch = vi.fn(async () => ok(AVAILABLE))
    const client = new BrowserPrint({ fetch: fetch as never, protocol: 'http:' })

    await client.printers()
    await client.printers()
    const afterTwo = fetch.mock.calls.length

    client.forget()
    await client.printers()

    expect(afterTwo).toBeLessThan(fetch.mock.calls.length)
  })
})

describe('timeouts', () => {
  it('gives up on a utility that never answers', async () => {
    const client = new BrowserPrint({
      fetch: ((_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })) as never,
      protocol: 'http:',
      probeTimeoutMs: 30,
    })

    expect(await client.available()).toBe(false)
  })
})

describe('BrowserPrintError', () => {
  it('is identifiable', () => {
    expect(new BrowserPrintError('x')).toBeInstanceOf(Error)
    expect(new BrowserPrintError('x').name).toBe('BrowserPrintError')
  })
})
