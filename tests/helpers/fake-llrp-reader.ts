import net from 'node:net'
import { once } from 'node:events'
import {
  MessageType,
  buildStatus,
  buildTagReport,
  decodeMessages,
  encodeMessage,
  type LlrpTagRead,
} from '@/lib/devices/llrp/protocol'

/**
 * A TCP server that actually speaks LLRP.
 *
 * It parses the real binary messages our client sends, answers with correctly
 * framed responses, and streams RO_ACCESS_REPORTs. That is what makes it worth
 * having: a mock would accept whatever we happened to send, so a wrong field
 * offset would pass here and fail on an FX9600 (DEVICE_INTEGRATION §11.1).
 */

export interface FakeLlrpReader {
  readonly port: number
  /** Message types received, in order — the bring-up sequence as it happened. */
  readonly received: number[]
  /** Pushes a tag report to the connected client. */
  report(reads: readonly LlrpTagRead[]): void
  /** Pushes a report split across two TCP writes, mid-message. */
  reportSplit(reads: readonly LlrpTagRead[]): void
  sendKeepalive(): void
  /** Makes the reader refuse the next command of this type. */
  refuse(type: number, code: number, description: string): void
  /** Makes the reader ignore the next command of this type entirely. */
  ignore(type: number): void
  dropConnection(): void
  keepaliveAcks(): number
  close(): Promise<void>
}

export async function startFakeLlrpReader(): Promise<FakeLlrpReader> {
  const received: number[] = []
  const refusals = new Map<number, { code: number; description: string }>()
  const ignored = new Set<number>()
  let client: net.Socket | null = null
  let buffer: Buffer = Buffer.alloc(0)
  let acks = 0

  const RESPONSE_FOR: Record<number, number> = {
    [MessageType.GET_READER_CAPABILITIES]: MessageType.GET_READER_CAPABILITIES_RESPONSE,
    [MessageType.SET_READER_CONFIG]: MessageType.SET_READER_CONFIG_RESPONSE,
    [MessageType.ADD_ROSPEC]: MessageType.ADD_ROSPEC_RESPONSE,
    [MessageType.DELETE_ROSPEC]: MessageType.DELETE_ROSPEC_RESPONSE,
    [MessageType.ENABLE_ROSPEC]: MessageType.ENABLE_ROSPEC_RESPONSE,
    [MessageType.DISABLE_ROSPEC]: MessageType.DISABLE_ROSPEC_RESPONSE,
    [MessageType.START_ROSPEC]: MessageType.START_ROSPEC_RESPONSE,
    [MessageType.STOP_ROSPEC]: MessageType.STOP_ROSPEC_RESPONSE,
    [MessageType.CLOSE_CONNECTION]: MessageType.CLOSE_CONNECTION_RESPONSE,
  }

  const server = net.createServer((socket) => {
    client = socket
    buffer = Buffer.alloc(0)

    // A real reader announces itself as soon as the connection is up.
    socket.write(encodeMessage(MessageType.READER_EVENT_NOTIFICATION, 0, buildStatus(0)))

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const { messages, rest } = decodeMessages(buffer)
      buffer = rest

      for (const message of messages) {
        if (message.type === MessageType.KEEPALIVE_ACK) {
          acks++
          continue
        }

        received.push(message.type)

        if (ignored.has(message.type)) {
          ignored.delete(message.type)
          continue
        }

        const responseType = RESPONSE_FOR[message.type]
        if (responseType === undefined) continue

        const refusal = refusals.get(message.type)
        if (refusal) {
          refusals.delete(message.type)
          socket.write(
            encodeMessage(responseType, message.id, buildStatus(refusal.code, refusal.description)),
          )
          continue
        }

        socket.write(encodeMessage(responseType, message.id, buildStatus(0)))
      }
    })

    socket.on('error', () => {})
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')

  const address = server.address()
  if (typeof address === 'string' || address === null) {
    throw new Error('The fake reader did not get a port.')
  }

  return {
    port: address.port,
    received,
    report(reads) {
      client?.write(encodeMessage(MessageType.RO_ACCESS_REPORT, 0, buildTagReport(reads)))
    },
    reportSplit(reads) {
      const message = encodeMessage(MessageType.RO_ACCESS_REPORT, 0, buildTagReport(reads))
      const cut = Math.floor(message.length / 2)
      client?.write(message.subarray(0, cut))
      // A separate write, so the client genuinely sees half a message first.
      setTimeout(() => client?.write(message.subarray(cut)), 5)
    },
    sendKeepalive() {
      client?.write(encodeMessage(MessageType.KEEPALIVE, 99))
    },
    refuse(type, code, description) {
      refusals.set(type, { code, description })
    },
    ignore(type) {
      ignored.add(type)
    },
    dropConnection() {
      client?.destroy()
    },
    keepaliveAcks() {
      return acks
    },
    async close() {
      client?.destroy()
      server.close()
      await once(server, 'close')
    },
  }
}
