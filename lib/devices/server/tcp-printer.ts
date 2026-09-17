import 'server-only'
import net from 'node:net'
import { labelCount, testLabel, validateZpl } from '@/lib/labels/zpl'
import {
  PrintOutcome,
  type PrinterConnector,
  type PrinterStatus,
  type PrintResult,
  type SelfTestReport,
  type SelfTestStep,
} from '../printer'

/**
 * A networked Zebra printer, spoken to directly over TCP 9100.
 *
 * This is the default print path because it needs nothing installed anywhere:
 * the server opens a socket to the printer's raw port and writes ZPL. Browsers
 * cannot open raw sockets, which is why printing is a server service at all
 * (WADR-014).
 *
 * Written against the real protocol and exercised against a TCP server that
 * actually accepts the connection and reads the bytes, so the socket lifecycle —
 * connect timeouts, partial writes, a connection dropped mid-job — is tested
 * rather than assumed (DEVICE_INTEGRATION §11.1).
 */

export interface TcpPrinterOptions {
  host: string
  port?: number
  label?: string
  /** Time to give up waiting for the socket to open. */
  connectTimeoutMs?: number
  /** Time to give up waiting for a reply to a status query. */
  replyTimeoutMs?: number
}

export const DEFAULT_PORT = 9100
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
const DEFAULT_REPLY_TIMEOUT_MS = 3_000

/** `~HS` asks the printer for its status. It answers with three CR/LF lines. */
const STATUS_QUERY = '~HS\r\n'

export class TcpPrinter implements PrinterConnector {
  readonly simulated = false
  readonly label: string

  private readonly host: string
  private readonly port: number
  private readonly connectTimeoutMs: number
  private readonly replyTimeoutMs: number

  constructor(options: TcpPrinterOptions) {
    this.host = options.host
    this.port = options.port ?? DEFAULT_PORT
    this.label = options.label ?? `${this.host}:${this.port}`
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.replyTimeoutMs = options.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS
  }

  async print(zpl: string): Promise<PrintResult> {
    const started = Date.now()

    // Refuse a malformed document before opening a socket. An unterminated
    // format leaves the printer waiting for the rest of a job that never
    // arrives, and the next job arrives into that state.
    try {
      validateZpl(zpl)
    } catch (error) {
      return {
        outcome: PrintOutcome.FAILED,
        labels: 0,
        bytesSent: 0,
        ms: Date.now() - started,
        message: 'This label was not sent, because a printer could not have used it.',
        error: error instanceof Error ? error.message : String(error),
      }
    }

    const payload = Buffer.from(zpl.endsWith('\n') ? zpl : `${zpl}\n`, 'utf8')

    try {
      const bytesSent = await this.send(payload)

      return {
        outcome: PrintOutcome.SENT,
        labels: labelCount(zpl),
        bytesSent,
        ms: Date.now() - started,
        // Deliberately "Sent", not "Printed". The socket closing means the
        // printer took the bytes, not that a label came out of it.
        message: `Sent to ${this.label}.`,
      }
    } catch (error) {
      return {
        outcome: PrintOutcome.FAILED,
        labels: 0,
        bytesSent: 0,
        ms: Date.now() - started,
        message: `Could not print to ${this.label}.`,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async status(): Promise<PrinterStatus> {
    try {
      const reply = await this.ask(Buffer.from(STATUS_QUERY, 'utf8'))
      return parseHostStatus(reply)
    } catch {
      // Unreachable, or a model that does not answer ~HS. Either way we do not
      // know anything about paper or the head, and must not pretend we do.
      return { online: false }
    }
  }

  async selfTest(): Promise<SelfTestReport> {
    const steps: SelfTestStep[] = []

    const socketStep = await step('Open socket', async () => {
      const socket = await this.connect()
      socket.destroy()
      return `Connected to ${this.host} on port ${this.port}.`
    })
    steps.push(socketStep)

    if (!socketStep.ok) {
      // Nothing after this can mean anything.
      return { device: this.label, ok: false, steps }
    }

    steps.push(
      await step('Query status (~HS)', async () => {
        const reply = await this.ask(Buffer.from(STATUS_QUERY, 'utf8'))
        const status = parseHostStatus(reply)
        return describeStatus(status)
      }),
    )

    steps.push(
      await step('Print a test label', async () => {
        const result = await this.print(testLabel(this.label, false))
        if (result.outcome === PrintOutcome.FAILED) throw new Error(result.error ?? 'failed')
        return `${result.bytesSent} bytes accepted in ${result.ms}ms. Check that a label came out — the socket cannot tell us.`
      }),
    )

    return { device: this.label, ok: steps.every((s) => s.ok), steps }
  }

  // -------------------------------------------------------------------------

  private connect(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port })

      // setTimeout covers idle time, not connect time, so the deadline is ours.
      const timer = setTimeout(() => {
        socket.destroy()
        reject(
          new Error(
            `${this.host}:${this.port} did not answer within ${this.connectTimeoutMs}ms. Check the address, and that the printer is powered on and on this network.`,
          ),
        )
      }, this.connectTimeoutMs)

      socket.once('connect', () => {
        clearTimeout(timer)
        resolve(socket)
      })

      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  /** Writes the payload and waits for the socket to close cleanly. */
  private async send(payload: Buffer): Promise<number> {
    const socket = await this.connect()

    return new Promise<number>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        socket.removeAllListeners()
        fn()
      }

      socket.once('error', (error) =>
        finish(() => {
          socket.destroy()
          reject(error)
        }),
      )

      // A close before we are done writing means the printer dropped the job
      // half-received. Reporting that as sent would leave somebody looking for
      // a label that was never fully delivered.
      socket.once('close', (hadError) =>
        finish(() => {
          if (hadError) reject(new Error('The printer closed the connection during the job.'))
          else resolve(payload.length)
        }),
      )

      // end() writes the payload and half-closes; the printer then closes its
      // side. write() may return false on a large job — end() still flushes it.
      socket.end(payload)
    })
  }

  /** Writes a query and collects whatever comes back before the socket closes. */
  private async ask(payload: Buffer): Promise<string> {
    const socket = await this.connect()

    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = []
      let settled = false

      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.removeAllListeners()
        fn()
      }

      const timer = setTimeout(() => {
        finish(() => {
          socket.destroy()
          // Some models simply do not answer. That is a fact about the printer,
          // not a failure to report as an error to the operator.
          if (chunks.length > 0) resolve(Buffer.concat(chunks).toString('utf8'))
          else reject(new Error(`No reply within ${this.replyTimeoutMs}ms.`))
        })
      }, this.replyTimeoutMs)

      socket.on('data', (chunk) => chunks.push(chunk))

      socket.once('error', (error) =>
        finish(() => {
          socket.destroy()
          reject(error)
        }),
      )

      socket.once('close', () =>
        finish(() => resolve(Buffer.concat(chunks).toString('utf8'))),
      )

      socket.write(payload)
    })
  }
}

/**
 * Parses the `~HS` reply.
 *
 * Three comma-separated lines. We read only the three fields whose position and
 * meaning are stable across Link-OS models, and leave the rest alone — a field
 * that means something else on another model is worse than a field we never
 * read, because the UI would state it with the same confidence.
 *
 *   Line 1: `aaa,b,c,dddd,…`  b = paper out, c = paused
 *   Line 2: `mmm,n,o,p,…`     o = head up (index 2, not 1 — n is unused)
 */
export function parseHostStatus(reply: string): PrinterStatus {
  const raw = reply.trim()
  if (!raw) return { online: false }

  const lines = raw
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean)

  const first = lines[0]?.split(',') ?? []
  const second = lines[1]?.split(',') ?? []

  const flag = (value: string | undefined): boolean | undefined =>
    value === undefined ? undefined : value.trim() === '1'

  return {
    online: true,
    paperOut: flag(first[1]),
    paused: flag(first[2]),
    headOpen: flag(second[2]),
    raw,
  }
}

/** The status in a sentence an operator can act on. */
export function describeStatus(status: PrinterStatus): string {
  if (!status.online) return 'The printer did not answer.'

  const problems: string[] = []
  if (status.paperOut) problems.push('out of labels')
  if (status.headOpen) problems.push('print head open')
  if (status.paused) problems.push('paused')

  if (problems.length > 0) return `The printer answered, and reports it is ${problems.join(', ')}.`

  // Only claim readiness for the fields it actually reported.
  const known = [status.paperOut, status.headOpen, status.paused].some((v) => v !== undefined)
  return known
    ? 'The printer answered and reports no problems.'
    : 'The printer answered, but did not report paper or head status.'
}

async function step(name: string, run: () => Promise<string>): Promise<SelfTestStep> {
  const started = Date.now()
  try {
    const detail = await run()
    return { name, ok: true, detail, ms: Date.now() - started }
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      ms: Date.now() - started,
    }
  }
}
