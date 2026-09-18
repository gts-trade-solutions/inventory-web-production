import { afterEach, describe, expect, it } from 'vitest'
import { LlrpReader } from '@/lib/devices/server/llrp-reader'
import { MessageType, type LlrpTagRead } from '@/lib/devices/llrp/protocol'
import { startFakeLlrpReader, type FakeLlrpReader } from './helpers/fake-llrp-reader'

/**
 * The fixed RFID reader, against a server that actually speaks LLRP.
 *
 * What can be tested without an FX9600 is the whole conversation: the bring-up
 * sequence, the framing under a heavy tag stream, keepalives, refusals and
 * reconnection. What cannot is read range, antenna tuning and stray-tag volume
 * (DEVICE_INTEGRATION §11.2).
 */

let reader: FakeLlrpReader | undefined
let client: LlrpReader | undefined

afterEach(async () => {
  client?.disconnect()
  client = undefined
  await reader?.close()
  reader = undefined
})

const EPC = '30361F49C800004000000001'

const tag = (epc: string, antenna = 1, rssi = -52): LlrpTagRead => ({
  epc,
  antenna,
  rssi,
  at: new Date('2026-09-17T09:15:30.250Z'),
})

function connect(port: number) {
  return new LlrpReader({
    host: '127.0.0.1',
    port,
    label: 'Aisle A reader',
    connectTimeoutMs: 1_000,
    replyTimeoutMs: 1_000,
    // A short sweep keeps the suite fast; the default is five seconds.
    selfTestInventoryMs: 300,
  })
}

describe('bring-up', () => {
  it('runs the sequence a reader expects, in order', async () => {
    reader = await startFakeLlrpReader()
    client = connect(reader.port)

    await client.startInventory()

    // Config, clear any stale spec, add, enable, start. The delete matters:
    // a spec left by a crashed process is rejected as a duplicate, and without
    // this the reader would need a reboot.
    expect(reader.received).toEqual([
      MessageType.SET_READER_CONFIG,
      MessageType.DELETE_ROSPEC,
      MessageType.ADD_ROSPEC,
      MessageType.ENABLE_ROSPEC,
      MessageType.START_ROSPEC,
    ])
  })

  it('reports an address with nothing listening', async () => {
    client = connect(1)

    await expect(client.startInventory()).rejects.toThrow()
  })

  it('stops cleanly', async () => {
    reader = await startFakeLlrpReader()
    client = connect(reader.port)

    await client.startInventory()
    reader.received.length = 0
    await client.stopInventory()

    expect(reader.received).toEqual([MessageType.STOP_ROSPEC, MessageType.DELETE_ROSPEC])
  })
})

describe('tag reports', () => {
  it('delivers tags the reader streams', async () => {
    reader = await startFakeLlrpReader()
    client = connect(reader.port)

    const seen: LlrpTagRead[] = []
    client.on('tags', (reads) => seen.push(...reads))

    await client.startInventory()
    reader.report([tag(EPC, 2, -47)])
    await settle()

    expect(seen).toEqual([{ epc: EPC, antenna: 2, rssi: -47, at: tag(EPC).at }])
  })

  it('handles a report split across two TCP writes', async () => {
    // The failure that only appears under a real socket: a reader sweeping an
    // aisle sends far more than fits one segment, and a client that assumed
    // one read equals one message would lose or mangle tags.
    reader = await startFakeLlrpReader()
    client = connect(reader.port)

    const seen: LlrpTagRead[] = []
    client.on('tags', (reads) => seen.push(...reads))

    await client.startInventory()
    reader.reportSplit([tag(EPC), tag('30361F49C800004000000002')])
    await settle(60)

    expect(seen.map((r) => r.epc)).toEqual([EPC, '30361F49C800004000000002'])
  })

  it('keeps up with a heavy sweep', async () => {
    reader = await startFakeLlrpReader()
    client = connect(reader.port)

    const seen: LlrpTagRead[] = []
    client.on('tags', (reads) => seen.push(...reads))

    await client.startInventory()

    // 20 reports of 50 tags: a pallet of tagged units passing an antenna.
    for (let batch = 0; batch < 20; batch++) {
      reader.report(
        Array.from({ length: 50 }, (_, i) =>
          tag(EPC.slice(0, 20) + String(batch * 50 + i).padStart(4, '0')),
        ),
      )
    }
    await settle(120)

    expect(seen).toHaveLength(1_000)
    expect(new Set(seen.map((r) => r.epc)).size).toBe(1_000)
  })

  it('collects a fixed window for a cycle count', async () => {
    reader = await startFakeLlrpReader()
    client = connect(reader.port)

    setTimeout(() => reader?.report([tag(EPC), tag('30361F49C800004000000002')]), 20)

    const reads = await client.inventoryFor(120)

    expect(reads.map((r) => r.epc)).toContain(EPC)
    expect(reads).toHaveLength(2)
  })

  it('stops listening once the window closes', async () => {
    reader = await startFakeLlrpReader()
    client = connect(reader.port)

    const reads = await client.inventoryFor(60)
    reader.report([tag(EPC)])
    await settle()

    // A late report must not land in a count that was already submitted.
    expect(reads).toHaveLength(0)
  })
})

describe('keepalives', () => {
  it('acknowledges them, so a quiet aisle stays connected', async () => {
    // Unacknowledged keepalives make a reader drop the connection. In a quiet
    // aisle that is the difference between hours of watching and nothing.
    reader = await startFakeLlrpReader()
    client = connect(reader.port)

    await client.startInventory()
    reader.sendKeepalive()
    reader.sendKeepalive()
    await settle()

    expect(reader.keepaliveAcks()).toBe(2)
  })

  it('asks the reader to send them', async () => {
    reader = await startFakeLlrpReader()
    client = connect(reader.port)

    await client.startInventory()

    expect(reader.received[0]).toBe(MessageType.SET_READER_CONFIG)
  })
})

describe('when the reader says no', () => {
  it('surfaces a refusal rather than sitting silently', async () => {
    // A reader that refuses an ROSpec and then says nothing looks exactly like
    // an aisle with no tags in it — and that count would come back empty and
    // be believed.
    reader = await startFakeLlrpReader()
    reader.refuse(MessageType.ADD_ROSPEC, 101, 'ROSpec already exists')
    client = connect(reader.port)

    await expect(client.startInventory()).rejects.toThrow(/ROSpec already exists/)
  })

  it('does not fail bring-up when clearing a spec that was not there', async () => {
    // DELETE_ROSPEC on a reader with no spec is an expected refusal, not a
    // problem — failing here would make every first connection look broken.
    reader = await startFakeLlrpReader()
    reader.refuse(MessageType.DELETE_ROSPEC, 101, 'ROSpec not found')
    client = connect(reader.port)

    await expect(client.startInventory()).resolves.toBeUndefined()
  })

  it('gives up when the reader never answers', async () => {
    reader = await startFakeLlrpReader()
    reader.ignore(MessageType.ADD_ROSPEC)
    client = connect(reader.port)

    await expect(client.startInventory()).rejects.toThrow(/did not answer/)
  })
})

describe('losing the connection', () => {
  it('says so instead of waiting for a timeout', async () => {
    reader = await startFakeLlrpReader()
    client = connect(reader.port)
    await client.startInventory()

    const reasons: string[] = []
    client.on('disconnected', (reason) => reasons.push(reason))

    reader.dropConnection()
    await settle(40)

    expect(reasons).toHaveLength(1)
    expect(client.connected).toBe(false)
  })

  it('fails a command in flight at once rather than after the timeout', async () => {
    // An operator watching a spinner for five seconds after we already knew the
    // answer is five seconds of not knowing whether to walk to the reader.
    reader = await startFakeLlrpReader()
    reader.ignore(MessageType.ADD_ROSPEC)
    client = connect(reader.port)

    const started = Date.now()
    const inventory = client.startInventory()
    setTimeout(() => reader?.dropConnection(), 20)

    await expect(inventory).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('can be reconnected afterwards', async () => {
    reader = await startFakeLlrpReader()
    client = connect(reader.port)
    await client.startInventory()

    reader.dropConnection()
    await settle(40)
    expect(client.connected).toBe(false)

    await client.startInventory()
    expect(client.connected).toBe(true)
  })
})

describe('selfTest', () => {
  it('reports each step of the bring-up', async () => {
    reader = await startFakeLlrpReader()
    client = connect(reader.port)

    setTimeout(() => reader?.report([tag(EPC), tag(EPC), tag('30361F49C800004000000002')]), 30)

    const report = await client.selfTest()

    expect(report.steps.map((s) => s.name)).toEqual([
      'Connect',
      'Read capabilities',
      'Inventory for 0 seconds',
    ])
    expect(report.ok).toBe(true)
    // Distinct tags, not raw reads: a reader sees the same tag many times per
    // sweep, and "3 reads" would flatter a single tag into three.
    expect(report.steps[2]?.detail).toMatch(/2 distinct tags/)
  })

  it('says plainly when nothing was seen', async () => {
    reader = await startFakeLlrpReader()
    client = connect(reader.port)

    const report = await client.selfTest()

    expect(report.steps[2]?.detail).toMatch(/no tags/i)
    expect(report.steps[2]?.detail).toMatch(/antennas|power/i)
  })

  it('stops after a failed connection', async () => {
    client = connect(1)

    const report = await client.selfTest()

    expect(report.ok).toBe(false)
    expect(report.steps).toHaveLength(1)
  })
})

function settle(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
