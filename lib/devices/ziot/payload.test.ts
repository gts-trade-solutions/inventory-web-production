import { describe, expect, it } from 'vitest'
import { ZiotPayloadError, readZiotPayload } from './payload'

/**
 * ZIoT payload parsing.
 *
 * Tested against recorded-shape payloads. What it cannot prove is that a given
 * firmware version sends exactly these fields — which is why it accepts several
 * shapes and reports what it could not read, rather than assuming one.
 */

const EPC = '30361F49C800004000000001'

describe('reading tag events', () => {
  it('reads the nested shape', () => {
    const payload = {
      type: 'SIMPLE',
      timestamp: '2026-09-18T09:15:30.250Z',
      data: { idHex: EPC, antenna: 2, peakRssi: -52, format: 'epc' },
    }

    const { reads } = readZiotPayload(payload)

    expect(reads).toEqual([
      { epc: EPC, antenna: 2, rssi: -52, at: new Date('2026-09-18T09:15:30.250Z') },
    ])
  })

  it('reads the flattened shape some firmware sends', () => {
    const { reads } = readZiotPayload({ idHex: EPC, antenna: 1, peakRssi: -60 })

    expect(reads[0]).toMatchObject({ epc: EPC, antenna: 1, rssi: -60 })
  })

  it('reads a batch', () => {
    const payload = Array.from({ length: 30 }, (_, i) => ({
      data: { idHex: EPC.slice(0, 22) + String(i).padStart(2, '0'), antenna: 1, peakRssi: -45 },
    }))

    expect(readZiotPayload(payload).reads).toHaveLength(30)
  })

  it('unwraps an envelope', () => {
    const payload = { data: [{ idHex: EPC, antenna: 1, peakRssi: -50 }] }

    expect(readZiotPayload(payload).reads).toHaveLength(1)
  })

  it('accepts a JSON string, as an MQTT message body would be', () => {
    const payload = JSON.stringify({ data: { idHex: EPC, antenna: 3, peakRssi: -41 } })

    expect(readZiotPayload(payload).reads[0]).toMatchObject({ epc: EPC, antenna: 3 })
  })

  it('upper-cases the EPC, so it matches what we store', () => {
    const { reads } = readZiotPayload({ idHex: EPC.toLowerCase() })

    expect(reads[0]?.epc).toBe(EPC)
  })

  it('names the reader when it sends one', () => {
    expect(readZiotPayload({ idHex: EPC, reader: 'FX9600-AisleA' }).reader).toBe('FX9600-AisleA')
  })
})

describe('timestamps', () => {
  it('reads epoch milliseconds', () => {
    const at = new Date('2026-09-18T09:15:30.250Z')

    expect(readZiotPayload({ idHex: EPC, timestamp: at.getTime() }).reads[0]?.at).toEqual(at)
  })

  it('reads epoch microseconds', () => {
    // Which format arrives depends on the firmware's clock setting. Reading
    // microseconds as milliseconds puts the read in the year 56000.
    const at = new Date('2026-09-18T09:15:30.250Z')
    const micros = at.getTime() * 1000

    expect(readZiotPayload({ idHex: EPC, timestamp: micros }).reads[0]?.at).toEqual(at)
  })

  it('falls back to our clock when there is none', () => {
    const now = new Date('2026-09-18T12:00:00.000Z')

    expect(readZiotPayload({ idHex: EPC }, now).reads[0]?.at).toEqual(now)
  })

  it('falls back when the timestamp is nonsense', () => {
    const now = new Date('2026-09-18T12:00:00.000Z')

    expect(readZiotPayload({ idHex: EPC, timestamp: 'not a date' }, now).reads[0]?.at).toEqual(now)
  })
})

describe('RSSI', () => {
  it('keeps a negative value as it is', () => {
    expect(readZiotPayload({ idHex: EPC, peakRssi: -52 }).reads[0]?.rssi).toBe(-52)
  })

  it('corrects a firmware sending it unsigned', () => {
    // "+52 dBm" is a number that looks real on a screen and is not.
    expect(readZiotPayload({ idHex: EPC, peakRssi: 52 }).reads[0]?.rssi).toBe(-52)
  })

  it('is null when absent, not zero', () => {
    // Zero dBm is an extremely strong read. Reporting "no data" as zero would
    // make every untagged read look like the antenna was touching the box.
    expect(readZiotPayload({ idHex: EPC }).reads[0]?.rssi).toBeNull()
  })
})

describe('what it refuses', () => {
  it('reports an entry with no EPC instead of dropping it', () => {
    // That tag was physically present and is about to be counted as missing.
    const { reads, skipped } = readZiotPayload([{ data: { antenna: 1 } }, { idHex: EPC }])

    expect(reads).toHaveLength(1)
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toMatch(/no EPC/)
  })

  it('refuses an EPC that is not hex', () => {
    // It would never match a unit, and keeping it shows up later as a mystery
    // "unknown tag" on the count.
    const { reads, skipped } = readZiotPayload({ idHex: 'NOT-HEX-AT-ALL' })

    expect(reads).toHaveLength(0)
    expect(skipped[0]).toMatch(/not hex/)
  })

  it('skips events that are not tag reads', () => {
    const { reads, skipped } = readZiotPayload([
      { type: 'HEARTBEAT', data: {} },
      { type: 'SIMPLE', data: { idHex: EPC } },
    ])

    expect(reads).toHaveLength(1)
    expect(skipped[0]).toMatch(/HEARTBEAT/)
  })

  it('carries on past one bad entry', () => {
    // A firmware upgrade that adds a field must not stop a cycle count.
    const { reads } = readZiotPayload([null, 'nonsense', { data: { idHex: EPC, antenna: 1 } }])

    expect(reads).toHaveLength(1)
  })

  it('rejects a payload that is not JSON at all', () => {
    expect(() => readZiotPayload('<html>')).toThrow(ZiotPayloadError)
    expect(() => readZiotPayload(42)).toThrow(ZiotPayloadError)
  })

  it('returns nothing for an empty batch', () => {
    expect(readZiotPayload([])).toEqual({ reads: [], skipped: [], reader: null })
  })
})
