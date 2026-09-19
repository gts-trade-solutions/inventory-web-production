import { afterEach, describe, expect, it, vi } from 'vitest'
import { log, redact, report } from './log'

/**
 * Structured logging.
 *
 * The two things worth testing are that a line can actually be parsed — a
 * "structured" log that is not valid JSON is prose with extra punctuation — and
 * that nothing sensitive reaches it. A log is the copy that ends up in a
 * third-party search index, so a password in one is a password published.
 */

afterEach(() => vi.restoreAllMocks())

function capture(run: () => void): Record<string, unknown> {
  const lines: string[] = []
  vi.spyOn(console, 'log').mockImplementation((text) => lines.push(String(text)))
  vi.spyOn(console, 'warn').mockImplementation((text) => lines.push(String(text)))
  vi.spyOn(console, 'error').mockImplementation((text) => lines.push(String(text)))

  run()

  return JSON.parse(lines[0] ?? '{}')
}

describe('the line', () => {
  it('is valid JSON with a level, an event and a timestamp', () => {
    const line = capture(() => log.info('print.queued', { requestId: 'abc' }))

    expect(line.level).toBe('info')
    expect(line.event).toBe('print.queued')
    expect(line.requestId).toBe('abc')
    expect(typeof line.at).toBe('string')
  })

  it('keeps the event as a stable slug rather than a sentence', () => {
    // Wording can then be improved without breaking the query that counts them.
    const line = capture(() => log.warn('sync.rejected', {}))

    expect(line.event).toBe('sync.rejected')
  })

  it('carries arbitrary context through', () => {
    const line = capture(() => log.info('count.approved', { sessionId: 's1', lines: 12 }))

    expect(line.sessionId).toBe('s1')
    expect(line.lines).toBe(12)
  })

  it('sends errors to stderr and everything else to stdout', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = vi.spyOn(console, 'log').mockImplementation(() => {})

    log.error('print.failed', new Error('nope'))
    log.info('print.queued')

    expect(err).toHaveBeenCalledTimes(1)
    expect(out).toHaveBeenCalledTimes(1)
  })
})

describe('errors', () => {
  it('keeps the message and the stack apart', () => {
    const line = capture(() => log.error('print.failed', new Error('printer refused')))

    expect(line.error).toBe('printer refused')
    expect(String(line.stack)).toContain('Error: printer refused')
  })

  it('survives something thrown that is not an Error', () => {
    const line = capture(() => log.error('odd', 'just a string'))

    expect(line.error).toBe('just a string')
    expect(line.stack).toBeUndefined()
  })
})

describe('redaction', () => {
  it('removes a password anywhere it appears', () => {
    const line = capture(() => log.info('auth.attempt', { email: 'a@b.c', password: 'hunter2' }))

    expect(line.password).toBe('[redacted]')
    expect(line.email).toBe('a@b.c')
  })

  it('removes secrets nested inside an object', () => {
    // The dangerous case: nobody logs a password on purpose, they log the
    // request body that happens to contain one.
    const line = capture(() =>
      log.info('api.request', { body: { user: { name: 'Sam', token: 'abc123' } } }),
    )

    const body = line.body as { user: Record<string, unknown> }
    expect(body.user.token).toBe('[redacted]')
    expect(body.user.name).toBe('Sam')
  })

  it('redacts inside arrays too', () => {
    const line = capture(() => log.info('batch', { rows: [{ secret: 'x' }, { secret: 'y' }] }))

    expect(line.rows).toEqual([{ secret: '[redacted]' }, { secret: '[redacted]' }])
  })

  it('does not hang on a circular structure', () => {
    // A logger that can crash the thing it is observing is worse than none.
    const circular: Record<string, unknown> = { name: 'loop' }
    circular.self = circular

    expect(() => redact(circular)).not.toThrow()
  })

  it('turns dates into something a log search can compare', () => {
    expect(redact({ at: new Date('2026-09-19T10:00:00.000Z') })).toEqual({
      at: '2026-09-19T10:00:00.000Z',
    })
  })

  it('caps a long array rather than writing a megabyte of log', () => {
    const long = Array.from({ length: 500 }, (_, index) => index)

    expect((redact(long) as number[]).length).toBe(50)
  })
})

describe('report', () => {
  it('logs the error, so the seam is not silent while Sentry is unwired', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    report('sync.failed', new Error('boom'), { requestId: 'r1' })

    expect(err).toHaveBeenCalledTimes(1)
    const line = JSON.parse(String(err.mock.calls[0]?.[0]))
    expect(line.event).toBe('sync.failed')
    expect(line.requestId).toBe('r1')
  })
})
