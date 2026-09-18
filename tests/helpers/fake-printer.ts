import net from 'node:net'
import { once } from 'node:events'

/**
 * A real TCP server standing in for a Zebra printer on port 9100.
 *
 * Not a mock object. It accepts a real connection, reads a real byte stream, and
 * can fail in the ways printers actually fail — refusing the connection, never
 * answering, dropping the socket mid-job. A connector verified against a mock
 * proves only that we can write a mock (DEVICE_INTEGRATION §11.1).
 */

export type FakePrinterBehaviour =
  | { kind: 'NORMAL' }
  /** Accepts the connection and then says nothing at all. Some models do this. */
  | { kind: 'SILENT' }
  /** Closes the socket part way through reading the job. */
  | { kind: 'DROP_MID_JOB'; afterBytes: number }
  /** Accepts and reads, but never closes its side. */
  | { kind: 'HANG' }

export interface FakePrinter {
  readonly port: number
  /** Every complete job the printer received, in order. */
  readonly jobs: string[]
  /** Connections accepted, including ones that sent nothing. */
  readonly connections: number
  behave(behaviour: FakePrinterBehaviour): void
  /** The canned ~HS reply. */
  respondToStatusWith(reply: string): void
  close(): Promise<void>
}

/**
 * A realistic `~HS` reply from a healthy printer: three lines, as the Link-OS
 * programming guide specifies. Line 1 field 1 is paper out and field 2 is
 * paused; line 2 field 2 is head up.
 */
export const HEALTHY_STATUS =
  '030,0,0,0317,000,0,0,0,000,0,0,0\r\n' + '001,0,0,0,0,2,6,0,00000000,1,000\r\n' + '1234,0\r\n'

export async function startFakePrinter(
  behaviour: FakePrinterBehaviour = { kind: 'NORMAL' },
): Promise<FakePrinter> {
  const jobs: string[] = []
  let connections = 0
  let current = behaviour
  let statusReply = HEALTHY_STATUS

  const server = net.createServer((socket) => {
    connections++
    const chunks: Buffer[] = []
    let received = 0

    socket.on('data', (chunk) => {
      chunks.push(chunk)
      received += chunk.length

      const text = chunk.toString('utf8')

      if (current.kind === 'DROP_MID_JOB' && received >= current.afterBytes) {
        // A printer that gives up half way. `destroy` with an error is what the
        // client sees as a connection reset, not a clean close.
        socket.destroy(new Error('reset by printer'))
        return
      }

      // A status query is answered on the same socket, like a real printer.
      if (text.includes('~HS') && current.kind !== 'SILENT') {
        socket.write(statusReply)
        if (current.kind !== 'HANG') socket.end()
      }
    })

    socket.on('end', () => {
      const job = Buffer.concat(chunks).toString('utf8')
      if (job.includes('^XA')) jobs.push(job)
      if (current.kind !== 'HANG') socket.end()
    })

    // Swallow resets so the double never crashes the test process.
    socket.on('error', () => {})
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const address = server.address()
  if (typeof address === 'string' || address === null) {
    throw new Error('The fake printer did not get a port.')
  }

  return {
    port: address.port,
    jobs,
    get connections() {
      return connections
    },
    behave(next) {
      current = next
    },
    respondToStatusWith(reply) {
      statusReply = reply
    },
    async close() {
      server.close()
      await once(server, 'close')
    },
  }
}

/**
 * A port with nothing listening on it.
 *
 * Opens a server to claim a free port, then closes it — so the port is real and
 * almost certainly still free, rather than a number we hoped was unused.
 */
export async function closedPort(): Promise<number> {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const address = server.address()
  if (typeof address === 'string' || address === null) throw new Error('no port')
  const port = address.port

  server.close()
  await once(server, 'close')
  return port
}
