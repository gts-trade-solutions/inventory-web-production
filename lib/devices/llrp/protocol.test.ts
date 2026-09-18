import { describe, expect, it } from 'vitest'
import {
  HEADER_BYTES,
  LlrpError,
  MessageType,
  ParameterType,
  buildAddRoSpec,
  buildStatus,
  buildTagReport,
  decodeMessages,
  decodeParameters,
  encodeMessage,
  findParameter,
  readStatus,
  readTagReport,
} from './protocol'

/**
 * LLRP is binary, so these assert on bytes.
 *
 * This is the layer that will meet a real FX9600 first, and the one where a
 * wrong offset produces plausible-looking nonsense rather than an error — an
 * RSSI read unsigned turns -52 dBm into 204, which looks like a number and is
 * not one.
 */

const EPC = '30361F49C800004000000001'

describe('message framing', () => {
  it('writes the header the spec describes', () => {
    const message = encodeMessage(MessageType.KEEPALIVE_ACK, 7)

    expect(message).toHaveLength(HEADER_BYTES)
    // 3 reserved bits, 3 version bits (1), 10 type bits (72).
    expect(message.readUInt16BE(0)).toBe((1 << 10) | 72)
    // Length includes the header.
    expect(message.readUInt32BE(2)).toBe(HEADER_BYTES)
    expect(message.readUInt32BE(6)).toBe(7)
  })

  it('round-trips a message with a body', () => {
    const body = Buffer.from([1, 2, 3, 4])
    const { messages, rest } = decodeMessages(encodeMessage(MessageType.ADD_ROSPEC, 42, body))

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ type: MessageType.ADD_ROSPEC, id: 42 })
    expect(messages[0]!.body).toEqual(body)
    expect(rest).toHaveLength(0)
  })

  it('splits several messages arriving in one read', () => {
    // TCP does not preserve message boundaries, and a reader sweeping an aisle
    // produces exactly this.
    const stream = Buffer.concat([
      encodeMessage(MessageType.KEEPALIVE, 1),
      encodeMessage(MessageType.RO_ACCESS_REPORT, 2, Buffer.from([9])),
      encodeMessage(MessageType.KEEPALIVE, 3),
    ])

    const { messages, rest } = decodeMessages(stream)

    expect(messages.map((m) => m.id)).toEqual([1, 2, 3])
    expect(rest).toHaveLength(0)
  })

  it('keeps a half-arrived message for the next read', () => {
    const whole = encodeMessage(MessageType.RO_ACCESS_REPORT, 5, Buffer.from([1, 2, 3, 4, 5, 6]))
    const firstHalf = whole.subarray(0, 12)

    const first = decodeMessages(firstHalf)
    expect(first.messages).toHaveLength(0)
    expect(first.rest).toEqual(firstHalf)

    const second = decodeMessages(Buffer.concat([first.rest, whole.subarray(12)]))
    expect(second.messages).toHaveLength(1)
    expect(second.messages[0]!.id).toBe(5)
  })

  it('returns nothing for less than a header', () => {
    const { messages, rest } = decodeMessages(Buffer.from([0x04, 0x3e]))

    expect(messages).toHaveLength(0)
    expect(rest).toHaveLength(2)
  })

  it('refuses a length that would never advance', () => {
    // A length shorter than the header means one corrupt byte spins forever.
    const corrupt = Buffer.alloc(HEADER_BYTES)
    corrupt.writeUInt16BE((1 << 10) | 62, 0)
    corrupt.writeUInt32BE(3, 2)

    expect(() => decodeMessages(corrupt)).toThrow(LlrpError)
  })

  it('refuses a type that does not fit the field', () => {
    expect(() => encodeMessage(0x400, 1)).toThrow(LlrpError)
  })
})

describe('parameters', () => {
  it('reads a fixed-length TV parameter', () => {
    const antenna = Buffer.from([0x80 | ParameterType.ANTENNA_ID, 0x00, 0x02])

    const [parameter] = decodeParameters(antenna)
    expect(parameter?.type).toBe(ParameterType.ANTENNA_ID)
    expect(parameter?.value.readUInt16BE(0)).toBe(2)
  })

  it('reads a TLV parameter and its children', () => {
    const report = buildTagReport([{ epc: EPC, antenna: 1, rssi: -52, at: new Date() }])

    const [parameter] = decodeParameters(report)
    expect(parameter?.type).toBe(ParameterType.TAG_REPORT_DATA)
    expect(findParameter(parameter!.children, ParameterType.EPC_96)).toBeDefined()
  })

  it('refuses an unknown fixed-length parameter rather than guessing', () => {
    // A TV parameter's length is not on the wire. Carrying on would read the
    // next parameter from the middle of this one, which produces numbers that
    // look real.
    expect(() => decodeParameters(Buffer.from([0x80 | 99, 1, 2, 3]))).toThrow(/cannot be read/)
  })

  it('stops cleanly at a truncated TLV', () => {
    const truncated = Buffer.from([0x00, 0xf0, 0x00, 0x40, 0x01])
    expect(decodeParameters(truncated)).toEqual([])
  })
})

describe('tag reports', () => {
  it('reads EPC, antenna, RSSI and timestamp', () => {
    const at = new Date('2026-09-17T09:15:30.250Z')
    const report = buildTagReport([{ epc: EPC, antenna: 3, rssi: -52, at }])

    expect(readTagReport(report)).toEqual([{ epc: EPC, antenna: 3, rssi: -52, at }])
  })

  it('reads RSSI as signed', () => {
    // The one that produces a plausible wrong answer: unsigned turns -52 into
    // 204, and 204 dBm is not a number anybody would question on a screen.
    const report = buildTagReport([{ epc: EPC, antenna: 1, rssi: -52, at: new Date() }])

    expect(readTagReport(report)[0]!.rssi).toBe(-52)
  })

  it('reads a whole sweep', () => {
    const reads = Array.from({ length: 40 }, (_, i) => ({
      epc: EPC.slice(0, 22) + String(i).padStart(2, '0'),
      antenna: (i % 4) + 1,
      rssi: -40 - i,
      at: new Date(),
    }))

    const parsed = readTagReport(buildTagReport(reads))

    expect(parsed).toHaveLength(40)
    expect(parsed.map((r) => r.epc)).toEqual(reads.map((r) => r.epc))
  })

  it('skips an entry with no EPC rather than losing the sweep', () => {
    // Readers do emit these. Dropping a full aisle because of one odd entry
    // turns a good count into a variance investigation.
    const withEpc = buildTagReport([{ epc: EPC, antenna: 1, rssi: -50, at: new Date() }])
    const empty = Buffer.from([0x00, 0xf0, 0x00, 0x04])

    const parsed = readTagReport(Buffer.concat([empty, withEpc]))

    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.epc).toBe(EPC)
  })

  it('uses our clock when the reader sends no timestamp', () => {
    const epc = Buffer.concat([Buffer.from([0x80 | ParameterType.EPC_96]), Buffer.from(EPC, 'hex')])
    const header = Buffer.alloc(4)
    header.writeUInt16BE(ParameterType.TAG_REPORT_DATA, 0)
    header.writeUInt16BE(4 + epc.length, 2)

    const now = new Date('2026-09-17T12:00:00.000Z')
    const [read] = readTagReport(Buffer.concat([header, epc]), now)

    expect(read?.at).toEqual(now)
    expect(read?.antenna).toBeNull()
    expect(read?.rssi).toBeNull()
  })

  it('produces EPCs the rest of the system can resolve', () => {
    // 24 upper-case hex, the same shape /counts/:id/tags accepts and that
    // serial_units.epc stores.
    const report = buildTagReport([{ epc: EPC, antenna: 1, rssi: -50, at: new Date() }])

    expect(readTagReport(report)[0]!.epc).toMatch(/^[0-9A-F]{24}$/)
  })

  it('is empty for a report carrying no tags', () => {
    expect(readTagReport(Buffer.alloc(0))).toEqual([])
  })
})

describe('status', () => {
  it('reads success', () => {
    expect(readStatus(buildStatus(0))).toEqual({ code: 0, ok: true, description: '' })
  })

  it('reads a failure with its description', () => {
    const status = readStatus(buildStatus(101, 'ROSpec not found'))

    expect(status?.ok).toBe(false)
    expect(status?.description).toBe('ROSpec not found')
  })

  it('returns null when the message carries no status', () => {
    expect(readStatus(Buffer.alloc(0))).toBeNull()
  })
})

describe('the inventory ROSpec', () => {
  it('is a well-formed ROSpec parameter', () => {
    const [roSpec] = decodeParameters(buildAddRoSpec())

    expect(roSpec?.type).toBe(177)
    // Its declared length matches the bytes produced, which is what a reader
    // checks before it does anything else.
    expect(buildAddRoSpec().readUInt16BE(2)).toBe(buildAddRoSpec().length)
  })

  it('asks for the fields a cycle count needs', () => {
    // An ROSpec starts with six fixed bytes — id, priority, state — before its
    // nested parameters, so its children are read from there rather than by the
    // generic decoder, which has no way to know that.
    const [roSpec] = decodeParameters(buildAddRoSpec())
    const children = decodeParameters(roSpec!.value.subarray(6))

    // ROReportSpec and its content selector have to be in there, or the reader
    // reports EPCs with no antenna or RSSI and the count cannot say where.
    expect(findParameter(children, 178)).toBeDefined() // ROBoundarySpec
    expect(findParameter(children, 183)).toBeDefined() // AISpec

    // ROReportSpec likewise carries three fixed bytes — trigger and N — before
    // the selector that names the fields we want.
    const reportSpec = findParameter(children, 237)
    expect(reportSpec).toBeDefined()

    const selector = decodeParameters(reportSpec!.value.subarray(3))[0]
    expect(selector?.type).toBe(238)
    // Bit 0 of the flags is ROSpecID and bit 3 is AntennaID; RSSI and
    // first-seen follow. Without them the reader reports bare EPCs and a count
    // cannot say which antenna saw what.
    expect(selector!.value.readUInt8(0) & 0b0001_0000).toBeTruthy() // AntennaID
    expect(selector!.value.readUInt8(0) & 0b0000_0100).toBeTruthy() // PeakRSSI
    expect(selector!.value.readUInt8(0) & 0b0000_0010).toBeTruthy() // FirstSeenTime
  })

  it('is wrapped in a message a reader would accept', () => {
    const message = encodeMessage(MessageType.ADD_ROSPEC, 1, buildAddRoSpec())
    const { messages } = decodeMessages(message)

    expect(messages[0]!.type).toBe(MessageType.ADD_ROSPEC)
    expect(decodeParameters(messages[0]!.body)[0]?.type).toBe(177)
  })
})
