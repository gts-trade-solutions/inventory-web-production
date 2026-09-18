import 'server-only'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import {
  DEFAULT_PORT,
  LlrpError,
  MessageType,
  buildAddRoSpec,
  buildRoSpecId,
  buildSetReaderConfig,
  decodeMessages,
  encodeMessage,
  readStatus,
  readTagReport,
  type LlrpMessage,
  type LlrpTagRead,
} from '../llrp/protocol'
import type { SelfTestReport, SelfTestStep } from '../printer'

/**
 * A fixed Zebra RFID reader (FX7500 / FX9600) over LLRP.
 *
 * The browser cannot open a socket to one, so fixed readers are a server
 * concern and tag reads reach the client over the event stream
 * (DEVICE_INTEGRATION §5).
 *
 * The bring-up sequence is fixed and small: connect, wait for the reader's
 * event notification, set a keepalive, add an ROSpec, enable it, start it. Tag
 * reports then arrive unprompted until we stop.
 */

export interface LlrpReaderOptions {
  host: string
  port?: number
  label?: string
  connectTimeoutMs?: number
  /** How long to wait for a reader to answer a command. */
  replyTimeoutMs?: number
  keepaliveSeconds?: number
  /** How long the self-test sweeps for. Longer finds more; 5s is the floor worth reporting. */
  selfTestInventoryMs?: number
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
const DEFAULT_REPLY_TIMEOUT_MS = 5_000
const DEFAULT_KEEPALIVE_SECONDS = 10
const DEFAULT_SELF_TEST_INVENTORY_MS = 5_000

export interface LlrpReaderEvents {
  tags: (reads: LlrpTagRead[]) => void
  /** Raised when the socket drops. The caller decides whether to reconnect. */
  disconnected: (reason: string) => void
}

export class LlrpReader extends EventEmitter {
  readonly label: string
  readonly simulated = false

  private readonly host: string
  private readonly port: number
  private readonly connectTimeoutMs: number
  private readonly replyTimeoutMs: number
  private readonly keepaliveSeconds: number
  private readonly selfTestInventoryMs: number

  private socket: net.Socket | null = null
  private buffer: Buffer = Buffer.alloc(0)
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (message: LlrpMessage) => void; reject: (error: Error) => void }
  >()
  private inventorying = false

  constructor(options: LlrpReaderOptions) {
    super()
    this.host = options.host
    this.port = options.port ?? DEFAULT_PORT
    this.label = options.label ?? `${this.host}:${this.port}`
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.replyTimeoutMs = options.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS
    this.keepaliveSeconds = options.keepaliveSeconds ?? DEFAULT_KEEPALIVE_SECONDS
    this.selfTestInventoryMs = options.selfTestInventoryMs ?? DEFAULT_SELF_TEST_INVENTORY_MS
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed
  }

  async connect(): Promise<void> {
    if (this.connected) return

    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const candidate = net.createConnection({ host: this.host, port: this.port })

      const timer = setTimeout(() => {
        candidate.destroy()
        reject(
          new LlrpError(
            `${this.host}:${this.port} did not answer within ${this.connectTimeoutMs}ms. Check the address and that the reader is on this network.`,
          ),
        )
      }, this.connectTimeoutMs)

      candidate.once('connect', () => {
        clearTimeout(timer)
        resolve(candidate)
      })
      candidate.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })

    this.socket = socket
    this.buffer = Buffer.alloc(0)

    socket.on('data', (chunk) => this.receive(chunk))
    socket.on('error', (error) => this.teardown(error.message))
    socket.on('close', () => this.teardown('The reader closed the connection.'))
  }

  /**
   * Starts continuous inventory. Tag reports arrive on the `tags` event.
   *
   * Each step waits for the reader's response and checks its status, because a
   * reader that refuses an ROSpec then sits there silently is indistinguishable
   * from an aisle with no tags in it — and the count would come back empty and
   * be believed.
   */
  async startInventory(): Promise<void> {
    if (!this.connected) await this.connect()

    await this.command(
      MessageType.SET_READER_CONFIG,
      buildSetReaderConfig(this.keepaliveSeconds),
      MessageType.SET_READER_CONFIG_RESPONSE,
    )

    // A spec left behind by a previous run would be rejected as a duplicate.
    // Deleting first is why a crashed process does not need a reader reboot.
    await this.command(
      MessageType.DELETE_ROSPEC,
      buildRoSpecId(),
      MessageType.DELETE_ROSPEC_RESPONSE,
      { ignoreStatus: true },
    )

    await this.command(MessageType.ADD_ROSPEC, buildAddRoSpec(), MessageType.ADD_ROSPEC_RESPONSE)
    await this.command(
      MessageType.ENABLE_ROSPEC,
      buildRoSpecId(),
      MessageType.ENABLE_ROSPEC_RESPONSE,
    )
    await this.command(MessageType.START_ROSPEC, buildRoSpecId(), MessageType.START_ROSPEC_RESPONSE)

    this.inventorying = true
  }

  async stopInventory(): Promise<void> {
    if (!this.connected || !this.inventorying) return

    try {
      await this.command(MessageType.STOP_ROSPEC, buildRoSpecId(), MessageType.STOP_ROSPEC_RESPONSE)
      await this.command(
        MessageType.DELETE_ROSPEC,
        buildRoSpecId(),
        MessageType.DELETE_ROSPEC_RESPONSE,
        { ignoreStatus: true },
      )
    } finally {
      this.inventorying = false
    }
  }

  /** Collects tags for a fixed window — what a cycle count actually does. */
  async inventoryFor(ms: number): Promise<LlrpTagRead[]> {
    const collected: LlrpTagRead[] = []
    const collect = (reads: LlrpTagRead[]) => collected.push(...reads)

    this.on('tags', collect)
    try {
      await this.startInventory()
      await new Promise((resolve) => setTimeout(resolve, ms))
      await this.stopInventory()
    } finally {
      this.off('tags', collect)
    }

    return collected
  }

  disconnect(): void {
    const socket = this.socket
    this.socket = null
    this.inventorying = false
    socket?.destroy()
  }

  async selfTest(): Promise<SelfTestReport> {
    const steps: SelfTestStep[] = []

    const connectStep = await step('Connect', async () => {
      await this.connect()
      return `Connected to ${this.host} on port ${this.port}.`
    })
    steps.push(connectStep)

    if (!connectStep.ok) return { device: this.label, ok: false, steps }

    steps.push(
      await step('Read capabilities', async () => {
        const reply = await this.command(
          MessageType.GET_READER_CAPABILITIES,
          Buffer.from([0]), // All capabilities
          MessageType.GET_READER_CAPABILITIES_RESPONSE,
        )
        return `Answered with ${reply.body.length} bytes of capabilities.`
      }),
    )

    steps.push(
      await step(
        `Inventory for ${Math.round(this.selfTestInventoryMs / 1000)} seconds`,
        async () => {
          const reads = await this.inventoryFor(this.selfTestInventoryMs)
          const unique = new Set(reads.map((read) => read.epc))
          return unique.size === 0
            ? 'Ran, but saw no tags. Check antennas, power and that there is tagged stock in range.'
            : `Saw ${unique.size} distinct tag${unique.size === 1 ? '' : 's'} in ${reads.length} reads.`
        },
      ),
    )

    this.disconnect()
    return { device: this.label, ok: steps.every((s) => s.ok), steps }
  }

  // -------------------------------------------------------------------------

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])

    let decoded
    try {
      decoded = decodeMessages(this.buffer)
    } catch (error) {
      // The stream can no longer be resynchronised, so the connection is the
      // only thing that can be reset. Carrying on would read every later
      // message from the wrong offset.
      this.teardown(error instanceof Error ? error.message : String(error))
      return
    }

    this.buffer = decoded.rest

    for (const message of decoded.messages) this.handle(message)
  }

  private handle(message: LlrpMessage): void {
    if (message.type === MessageType.RO_ACCESS_REPORT) {
      const reads = readTagReport(message.body)
      if (reads.length > 0) this.emit('tags', reads)
      return
    }

    if (message.type === MessageType.KEEPALIVE) {
      // Unacknowledged keepalives make a reader drop the connection, so this
      // is what keeps a reader watching a quiet aisle for hours.
      this.socket?.write(encodeMessage(MessageType.KEEPALIVE_ACK, message.id))
      return
    }

    const waiting = this.pending.get(message.id)
    if (waiting) {
      this.pending.delete(message.id)
      waiting.resolve(message)
    }
  }

  private async command(
    type: number,
    body: Buffer,
    expect: number,
    options: { ignoreStatus?: boolean } = {},
  ): Promise<LlrpMessage> {
    const socket = this.socket
    if (!socket) throw new LlrpError('Not connected to the reader.')

    const id = this.nextId++

    const reply = await new Promise<LlrpMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new LlrpError(`The reader did not answer within ${this.replyTimeoutMs}ms.`))
      }, this.replyTimeoutMs)

      this.pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer)
          resolve(message)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })

      socket.write(encodeMessage(type, id, body))
    })

    if (reply.type !== expect && reply.type !== MessageType.ERROR_MESSAGE) {
      throw new LlrpError(`Expected message type ${expect} but the reader sent ${reply.type}.`)
    }

    if (!options.ignoreStatus) {
      const status = readStatus(reply.body)
      if (status && !status.ok) {
        throw new LlrpError(
          `The reader refused the command: ${status.description || `status ${status.code}`}.`,
        )
      }
    }

    return reply
  }

  private teardown(reason: string): void {
    const socket = this.socket
    this.socket = null
    this.inventorying = false
    socket?.destroy()

    // Fail everything still waiting, now. The reply can no longer arrive, and
    // leaving these to time out means an operator watches a spinner for five
    // seconds after we already knew the answer.
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const { reject } of waiting) reject(new LlrpError(reason))

    this.emit('disconnected', reason)
  }
}

async function step(name: string, run: () => Promise<string>): Promise<SelfTestStep> {
  const started = Date.now()
  try {
    return { name, ok: true, detail: await run(), ms: Date.now() - started }
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      ms: Date.now() - started,
    }
  }
}
