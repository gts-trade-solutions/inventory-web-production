import { afterEach, describe, expect, it } from 'vitest'
import { TcpPrinter, describeStatus, parseHostStatus } from '@/lib/devices/server/tcp-printer'
import { PrintOutcome } from '@/lib/devices/printer'
import { testLabel } from '@/lib/labels/zpl'
import { HEALTHY_STATUS, closedPort, startFakePrinter, type FakePrinter } from './helpers/fake-printer'

/**
 * The TCP 9100 print path, against something that actually speaks it.
 *
 * We have no Zebra printers. What can still be tested without one is the whole
 * socket lifecycle — and that is where the failures live: a printer that is
 * powered off, one that never answers, one that drops the job half way. Those
 * are tested here against a real TCP server, not a mock (DEVICE_INTEGRATION
 * §11.1).
 */

let printer: FakePrinter | undefined

afterEach(async () => {
  await printer?.close()
  printer = undefined
})

const LABEL = '^XA^CI28^FO30,30^A0N,40,40^FDCordless drill^FS^XZ'

const connect = (port: number, overrides = {}) =>
  new TcpPrinter({
    host: '127.0.0.1',
    port,
    label: 'Test printer',
    connectTimeoutMs: 1_000,
    replyTimeoutMs: 500,
    ...overrides,
  })

describe('printing', () => {
  it('delivers the exact bytes a printer would receive', async () => {
    printer = await startFakePrinter()

    const result = await connect(printer.port).print(LABEL)

    expect(result.outcome).toBe(PrintOutcome.SENT)
    expect(result.labels).toBe(1)
    // The job that arrived, byte for byte — not a description of it.
    expect(printer.jobs).toHaveLength(1)
    expect(printer.jobs[0]).toBe(`${LABEL}\n`)
  })

  it('says sent, not printed', async () => {
    // TCP 9100 is fire-and-forget. The socket closing means the printer took the
    // bytes, not that a label came out. Claiming otherwise sends somebody
    // looking for a label that never existed.
    printer = await startFakePrinter()

    const result = await connect(printer.port).print(LABEL)

    expect(result.outcome).not.toBe(PrintOutcome.CONFIRMED)
    expect(result.message).toMatch(/sent/i)
    expect(result.message).not.toMatch(/printed/i)
  })

  it('sends a multi-label job in one connection', async () => {
    printer = await startFakePrinter()

    const job = `${LABEL}\n${LABEL}\n${LABEL}`
    const result = await connect(printer.port).print(job)

    expect(result.labels).toBe(3)
    expect(printer.connections).toBe(1)
  })

  it('reports the printer being off before anything else', async () => {
    // The commonest failure on the floor, and the one whose message has to say
    // what to go and check.
    const port = await closedPort()

    const result = await connect(port).print(LABEL)

    expect(result.outcome).toBe(PrintOutcome.FAILED)
    expect(result.error).toBeTruthy()
    expect(result.message).toContain('Test printer')
  })

  it('gives up on an address that never answers', async () => {
    // 10.255.255.1 is a reserved address that black-holes rather than refusing,
    // so this exercises the connect deadline rather than a fast rejection.
    const result = await new TcpPrinter({
      host: '10.255.255.1',
      port: 9100,
      label: 'Unreachable',
      connectTimeoutMs: 300,
    }).print(LABEL)

    expect(result.outcome).toBe(PrintOutcome.FAILED)
    expect(result.error).toMatch(/did not answer|timeout|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/i)
  }, 10_000)

  it('does not claim success when the printer drops the job half way', async () => {
    // The nastiest case: bytes were accepted, then the connection died. Calling
    // that "sent" leaves a half-delivered job nobody knows about.
    //
    // The job has to be big enough that the reset arrives while we are still
    // writing — a small one is handed to the kernel in a single segment and the
    // drop is indistinguishable from a clean close, which is a real limit of
    // TCP 9100 rather than something the connector can paper over.
    printer = await startFakePrinter({ kind: 'DROP_MID_JOB', afterBytes: 2_000 })

    const job = Array.from({ length: 5_000 }, () => LABEL).join('\n')
    const result = await connect(printer.port).print(job)

    expect(result.outcome).toBe(PrintOutcome.FAILED)
    expect(result.error).toBeTruthy()
  })

  it('refuses a malformed document without opening a socket', async () => {
    // An unterminated format leaves the printer waiting for the rest of a job
    // that never arrives, and the next job arrives into that state.
    printer = await startFakePrinter()

    const result = await connect(printer.port).print('^XA^FDno terminator')

    expect(result.outcome).toBe(PrintOutcome.FAILED)
    expect(result.error).toMatch(/\^XZ/)
    expect(printer.connections).toBe(0)
  })

  it('sends a large job without truncating it', async () => {
    // One format per unit for RFID encoding produces jobs far larger than a
    // single socket write, so a partial write that went unhandled would silently
    // drop labels off the end of the run.
    printer = await startFakePrinter()

    const job = Array.from({ length: 400 }, () => LABEL).join('\n')
    const result = await connect(printer.port).print(job)

    expect(result.labels).toBe(400)
    expect(result.bytesSent).toBe(Buffer.byteLength(`${job}\n`))
    expect(printer.jobs[0]).toHaveLength(job.length + 1)
  })
})

describe('status', () => {
  it('reads a healthy printer', async () => {
    printer = await startFakePrinter()

    const status = await connect(printer.port).status()

    expect(status.online).toBe(true)
    expect(status.paperOut).toBe(false)
    expect(status.headOpen).toBe(false)
  })

  it('reports a printer that is out of labels', async () => {
    printer = await startFakePrinter()
    printer.respondToStatusWith(
      '030,1,0,0317,000,0,0,0,000,0,0,0\r\n001,0,0,0,0,2,6,0,00000000,1,000\r\n',
    )

    const status = await connect(printer.port).status()

    expect(status.paperOut).toBe(true)
    expect(describeStatus(status)).toMatch(/out of labels/)
  })

  it('does not invent an answer from a printer that gives none', async () => {
    // Plenty of models never reply to ~HS. "We do not know" and "everything is
    // fine" must not render the same way.
    printer = await startFakePrinter({ kind: 'SILENT' })

    const status = await connect(printer.port).status()

    expect(status.online).toBe(false)
    expect(status.paperOut).toBeUndefined()
    expect(describeStatus(status)).toMatch(/did not answer/)
  })

  it('reports unreachable rather than throwing', async () => {
    const port = await closedPort()
    expect(await connect(port).status()).toEqual({ online: false })
  })
})

describe('parseHostStatus', () => {
  it('reads the fields whose meaning is stable across models', () => {
    expect(parseHostStatus(HEALTHY_STATUS)).toMatchObject({
      online: true,
      paperOut: false,
      paused: false,
    })
  })

  it('reads paused and head-open', () => {
    // Head up is field 2 on line 2, not field 1 — field 1 is unused. Reading the
    // wrong one reports an open print head on every healthy printer.
    const reply =
      '030,0,1,0317,000,0,0,0,000,0,0,0\r\n001,0,1,0,0,2,6,0,00000000,1,000\r\n'
    const status = parseHostStatus(reply)

    expect(status.paused).toBe(true)
    expect(status.headOpen).toBe(true)
    expect(describeStatus(status)).toMatch(/paused/)
  })

  it('leaves fields absent when the printer did not send them', () => {
    const status = parseHostStatus('000')

    expect(status.online).toBe(true)
    expect(status.paperOut).toBeUndefined()
    expect(describeStatus(status)).toMatch(/did not report/)
  })

  it('treats an empty reply as no answer', () => {
    expect(parseHostStatus('')).toEqual({ online: false })
    expect(parseHostStatus('   \r\n')).toEqual({ online: false })
  })
})

describe('selfTest', () => {
  it('reports what happened at each step', async () => {
    printer = await startFakePrinter()

    const report = await connect(printer.port).selfTest()

    expect(report.ok).toBe(true)
    expect(report.steps.map((s) => s.name)).toEqual([
      'Open socket',
      'Query status (~HS)',
      'Print a test label',
    ])
    // Every step says what happened, not just whether it passed — this is the
    // bring-up record somebody reads on hardware day.
    expect(report.steps.every((s) => s.detail.length > 0)).toBe(true)
    expect(printer.jobs.some((job) => job.includes('Inventory test label'))).toBe(true)
  })

  it('stops after the socket fails rather than reporting noise', async () => {
    const port = await closedPort()

    const report = await connect(port).selfTest()

    expect(report.ok).toBe(false)
    expect(report.steps).toHaveLength(1)
    expect(report.steps[0]?.ok).toBe(false)
  })

  it('carries on when only the status query fails', async () => {
    // A printer that ignores ~HS still prints. Failing the whole bring-up over
    // an optional query would send somebody chasing a problem that is not one.
    printer = await startFakePrinter({ kind: 'SILENT' })

    const report = await connect(printer.port).selfTest()

    expect(report.steps).toHaveLength(3)
    expect(report.steps[1]?.ok).toBe(false)
    expect(report.steps[2]?.ok).toBe(true)
  })

  it('prints a test label that is valid on its own', async () => {
    printer = await startFakePrinter()
    await connect(printer.port).selfTest()

    const printed = printer.jobs.find((job) => job.includes('Inventory test label'))
    expect(printed).toContain('^XA')
    expect(printed).toContain('^XZ')
    expect(printed).toContain('Test printer')
  })
})

describe('the label the bring-up checklist uses', () => {
  it('is generated, not stored, so it works before anything is configured', () => {
    expect(testLabel('ZD621R', false)).toContain('^XA')
  })
})
