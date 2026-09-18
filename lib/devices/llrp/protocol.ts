/**
 * LLRP — Low Level Reader Protocol, the standard a fixed RFID reader speaks.
 *
 * Zebra's FX7500 and FX9600 both talk it on TCP 5084. It is a binary protocol,
 * so the framing and the tag-report parsing are where the bugs live — and both
 * are pure functions here, testable byte for byte against captures without a
 * reader in the room (DEVICE_INTEGRATION §11.1).
 *
 * Reference: EPCglobal LLRP 1.0.1 and 1.1.
 *
 * Deliberately no socket code: this module knows the protocol, and `LlrpReader`
 * knows the network. Mixing the two is what makes a binary protocol impossible
 * to test.
 */

export class LlrpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlrpError'
  }
}

/** The message types we send or care about receiving. */
export const MessageType = {
  GET_READER_CAPABILITIES: 1,
  SET_READER_CONFIG: 3,
  CLOSE_CONNECTION_RESPONSE: 4,
  GET_READER_CAPABILITIES_RESPONSE: 11,
  SET_READER_CONFIG_RESPONSE: 13,
  CLOSE_CONNECTION: 14,
  ADD_ROSPEC: 20,
  DELETE_ROSPEC: 21,
  START_ROSPEC: 22,
  STOP_ROSPEC: 23,
  ENABLE_ROSPEC: 24,
  DISABLE_ROSPEC: 25,
  ADD_ROSPEC_RESPONSE: 30,
  DELETE_ROSPEC_RESPONSE: 31,
  START_ROSPEC_RESPONSE: 32,
  STOP_ROSPEC_RESPONSE: 33,
  ENABLE_ROSPEC_RESPONSE: 34,
  DISABLE_ROSPEC_RESPONSE: 35,
  RO_ACCESS_REPORT: 61,
  KEEPALIVE: 62,
  READER_EVENT_NOTIFICATION: 63,
  KEEPALIVE_ACK: 72,
  ERROR_MESSAGE: 100,
} as const
export type MessageType = (typeof MessageType)[keyof typeof MessageType]

export const LLRP_VERSION = 1
export const HEADER_BYTES = 10
export const DEFAULT_PORT = 5084

export interface LlrpMessage {
  type: number
  id: number
  /** Everything after the 10-byte header. */
  body: Buffer
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/**
 * Header layout: 3 reserved bits, 3 version bits, 10 type bits, then a 4-byte
 * length that INCLUDES the header, then a 4-byte message id.
 */
export function encodeMessage(type: number, id: number, body: Buffer = Buffer.alloc(0)): Buffer {
  if (type < 0 || type > 0x3ff) throw new LlrpError(`Message type ${type} does not fit in 10 bits.`)

  const header = Buffer.alloc(HEADER_BYTES)
  header.writeUInt16BE((LLRP_VERSION << 10) | type, 0)
  header.writeUInt32BE(HEADER_BYTES + body.length, 2)
  header.writeUInt32BE(id >>> 0, 6)

  return Buffer.concat([header, body])
}

/**
 * Pulls whole messages out of a stream buffer.
 *
 * TCP does not preserve message boundaries: one read can hold three reports and
 * half of a fourth, and a reader sweeping a full aisle produces exactly that.
 * Returns what is complete and the bytes still waiting for the rest.
 */
export function decodeMessages(buffer: Buffer): { messages: LlrpMessage[]; rest: Buffer } {
  const messages: LlrpMessage[] = []
  let offset = 0

  while (buffer.length - offset >= HEADER_BYTES) {
    const length = buffer.readUInt32BE(offset + 2)

    if (length < HEADER_BYTES) {
      // A length shorter than the header would never advance the offset, so a
      // single corrupt byte would spin forever.
      throw new LlrpError(`A message claims to be ${length} bytes, shorter than its own header.`)
    }
    if (buffer.length - offset < length) break

    const word = buffer.readUInt16BE(offset)
    messages.push({
      type: word & 0x3ff,
      id: buffer.readUInt32BE(offset + 6),
      body: buffer.subarray(offset + HEADER_BYTES, offset + length),
    })

    offset += length
  }

  return { messages, rest: buffer.subarray(offset) }
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/**
 * Parameter types we read out of a tag report.
 *
 * TV parameters are fixed-length with a 1-byte header (high bit set, type in
 * the low 7 bits). TLV parameters have a 10-bit type and a 2-byte length.
 */
export const ParameterType = {
  ANTENNA_ID: 1,
  FIRST_SEEN_TIMESTAMP_UTC: 2,
  PEAK_RSSI: 6,
  RO_SPEC_ID: 9,
  EPC_96: 13,
  LLRP_STATUS: 287,
  EPC_DATA: 241,
  TAG_REPORT_DATA: 240,
} as const

/** Byte lengths of the TV parameters we read; others are skipped by lookup. */
const TV_LENGTHS: Record<number, number> = {
  1: 2, // AntennaID: uint16
  2: 8, // FirstSeenTimestampUTC: uint64 microseconds
  3: 8, // FirstSeenTimestampUptime
  4: 8, // LastSeenTimestampUTC
  5: 8, // LastSeenTimestampUptime
  6: 1, // PeakRSSI: int8
  7: 2, // Channel index
  8: 2, // TagSeenCount
  9: 4, // ROSpecID
  10: 2, // InventoryParameterSpecID
  11: 1, // C1G2 PC
  12: 2, // C1G2 CRC
  13: 12, // EPC-96: 96 bits
  14: 2, // SpecIndex
  15: 2, // ClientRequestOpSpecResult
  16: 2, // AccessSpecID
  17: 2, // OpSpecID
  18: 2, // C1G2 SingulationDetails
  19: 2, // C1G2 XPC_W1
  20: 2, // C1G2 XPC_W2
}

export interface LlrpParameter {
  type: number
  value: Buffer
  /** TLV parameters can nest; TV ones never do. */
  children: LlrpParameter[]
}

export function decodeParameters(buffer: Buffer): LlrpParameter[] {
  const parameters: LlrpParameter[] = []
  let offset = 0

  while (offset < buffer.length) {
    const first = buffer.readUInt8(offset)

    if ((first & 0x80) !== 0) {
      // TV: fixed length, looked up by type.
      const type = first & 0x7f
      const length = TV_LENGTHS[type]
      if (length === undefined) {
        // An unknown TV parameter cannot be skipped, because its length is not
        // on the wire. Stopping is the only safe move — carrying on would read
        // the next parameter from the middle of this one.
        throw new LlrpError(
          `Unknown fixed-length parameter ${type}. The rest of this message cannot be read safely.`,
        )
      }
      if (offset + 1 + length > buffer.length) break

      parameters.push({
        type,
        value: buffer.subarray(offset + 1, offset + 1 + length),
        children: [],
      })
      offset += 1 + length
      continue
    }

    // TLV: 6 reserved bits, 10 type bits, 2-byte length including the header.
    if (offset + 4 > buffer.length) break

    const type = buffer.readUInt16BE(offset) & 0x3ff
    const length = buffer.readUInt16BE(offset + 2)
    if (length < 4 || offset + length > buffer.length) break

    const value = buffer.subarray(offset + 4, offset + length)
    parameters.push({ type, value, children: safeChildren(value) })
    offset += length
  }

  return parameters
}

/**
 * A TLV's contents may be nested parameters, raw bytes, or fixed fields
 * followed by nested parameters.
 *
 * Nothing on the wire says which, and LLRP has no general answer — knowing that
 * an ROSpec begins with six fixed bytes before its children means knowing the
 * ROSpec definition. So this only resolves children for parameters that are
 * entirely nested, which is the case for TagReportData and is the only case we
 * read. Anything else comes back with no children rather than with wrong ones.
 */
function safeChildren(value: Buffer): LlrpParameter[] {
  try {
    return decodeParameters(value)
  } catch {
    return []
  }
}

export function findParameter(
  parameters: readonly LlrpParameter[],
  type: number,
): LlrpParameter | undefined {
  for (const parameter of parameters) {
    if (parameter.type === type) return parameter
    const nested = findParameter(parameter.children, type)
    if (nested) return nested
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Tag reports
// ---------------------------------------------------------------------------

export interface LlrpTagRead {
  epc: string
  antenna: number | null
  /** dBm. Negative; closer to zero is a stronger read. */
  rssi: number | null
  at: Date
}

/**
 * Reads the tags out of an RO_ACCESS_REPORT.
 *
 * One report carries many TagReportData parameters, and a report is the only
 * thing in LLRP we actually need: everything else in this module exists to get
 * the reader to the point of sending them.
 *
 * A TagReportData with no EPC is skipped rather than throwing. Readers do emit
 * them — an access-spec result with no inventory data, for one — and dropping
 * an entire sweep of a full aisle because of one odd entry would turn a good
 * count into a variance investigation.
 */
export function readTagReport(body: Buffer, now: Date = new Date()): LlrpTagRead[] {
  const reads: LlrpTagRead[] = []

  for (const parameter of decodeParameters(body)) {
    if (parameter.type !== ParameterType.TAG_REPORT_DATA) continue

    const epc = epcOf(parameter.children)
    if (!epc) continue

    reads.push({
      epc,
      antenna: numberOf(parameter.children, ParameterType.ANTENNA_ID),
      rssi: rssiOf(parameter.children),
      at: timestampOf(parameter.children) ?? now,
    })
  }

  return reads
}

function epcOf(children: readonly LlrpParameter[]): string | null {
  // EPC-96 is a TV parameter; EPCData is the TLV form for other tag lengths,
  // whose value starts with a 2-byte bit count.
  const epc96 = findParameter(children, ParameterType.EPC_96)
  if (epc96 && epc96.value.length === 12) return epc96.value.toString('hex').toUpperCase()

  const epcData = findParameter(children, ParameterType.EPC_DATA)
  if (epcData && epcData.value.length > 2) {
    const bits = epcData.value.readUInt16BE(0)
    const bytes = Math.ceil(bits / 8)
    if (bytes > 0 && epcData.value.length >= 2 + bytes) {
      return epcData.value.subarray(2, 2 + bytes).toString('hex').toUpperCase()
    }
  }

  return null
}

function numberOf(children: readonly LlrpParameter[], type: number): number | null {
  const parameter = findParameter(children, type)
  if (!parameter) return null

  if (parameter.value.length === 2) return parameter.value.readUInt16BE(0)
  if (parameter.value.length === 4) return parameter.value.readUInt32BE(0)
  if (parameter.value.length === 1) return parameter.value.readUInt8(0)
  return null
}

function rssiOf(children: readonly LlrpParameter[]): number | null {
  const parameter = findParameter(children, ParameterType.PEAK_RSSI)
  // Signed: RSSI is negative dBm, and reading it unsigned turns -52 into 204.
  return parameter && parameter.value.length === 1 ? parameter.value.readInt8(0) : null
}

function timestampOf(children: readonly LlrpParameter[]): Date | null {
  const parameter = findParameter(children, ParameterType.FIRST_SEEN_TIMESTAMP_UTC)
  if (!parameter || parameter.value.length !== 8) return null

  // Microseconds since the epoch, as a uint64. Milliseconds is as fine as a
  // JS Date gets, and a tag read does not need better.
  const micros = parameter.value.readBigUInt64BE(0)
  return new Date(Number(micros / 1000n))
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface LlrpStatus {
  code: number
  ok: boolean
  description: string
}

/** LLRPStatus: a 2-byte code, then a length-prefixed description. */
export function readStatus(body: Buffer): LlrpStatus | null {
  const status = findParameter(decodeParameters(body), ParameterType.LLRP_STATUS)
  if (!status || status.value.length < 4) return null

  const code = status.value.readUInt16BE(0)
  const length = status.value.readUInt16BE(2)
  const description =
    length > 0 && status.value.length >= 4 + length
      ? status.value.subarray(4, 4 + length).toString('utf8')
      : ''

  return { code, ok: code === 0, description }
}

// ---------------------------------------------------------------------------
// Building the inventory ROSpec
// ---------------------------------------------------------------------------

export const ROSPEC_ID = 1

/**
 * The one ROSpec we use: read every antenna continuously and report each tag
 * once per sweep, with antenna, RSSI and timestamp.
 *
 * Hand-built bytes rather than a general encoder. We send exactly four
 * messages, and a general-purpose LLRP encoder would be far more code to get
 * wrong for no benefit — the spec we need does not vary.
 */
export function buildAddRoSpec(): Buffer {
  // ROReportSpec (237): trigger = Upon_N_Tags_Or_End_Of_ROSpec(1), N = 1,
  // containing TagReportContentSelector (238).
  const contentSelector = tlv(
    238,
    Buffer.from([
      // Bit flags: ROSpecID, SpecIndex, InventoryParameterSpecID, AntennaID,
      // ChannelIndex, PeakRSSI, FirstSeenTime, LastSeenTime, TagSeenCount,
      // then C1G2 fields. We ask for antenna, RSSI and first-seen.
      0b1001_0110, 0b0000_0000,
    ]),
  )
  const reportSpec = tlv(237, Buffer.concat([Buffer.from([1, 0, 1]), contentSelector]))

  // AISpec (183): antenna count 1, antenna 0 (= all), stop trigger null.
  const inventorySpec = tlv(
    186, // InventoryParameterSpec
    Buffer.concat([
      Buffer.from([0, 1]), // InventoryParameterSpecID = 1
      Buffer.from([1]), // AirProtocol = EPCGlobalClass1Gen2
    ]),
  )
  const aiSpecStopTrigger = tlv(184, Buffer.from([0, 0, 0, 0, 0])) // Null trigger
  const aiSpec = tlv(
    183,
    Buffer.concat([
      Buffer.from([0, 1, 0, 0]), // 1 antenna, antenna ID 0 = every antenna
      aiSpecStopTrigger,
      inventorySpec,
    ]),
  )

  // ROBoundarySpec (178): start immediately, never stop on its own.
  const startTrigger = tlv(179, Buffer.from([0])) // Null: started by START_ROSPEC
  const stopTrigger = tlv(182, Buffer.from([0, 0, 0, 0, 0])) // Null
  const boundary = tlv(178, Buffer.concat([startTrigger, stopTrigger]))

  const roSpec = tlv(
    177,
    Buffer.concat([
      uint32(ROSPEC_ID),
      Buffer.from([0]), // Priority
      Buffer.from([0]), // CurrentState = Disabled
      boundary,
      aiSpec,
      reportSpec,
    ]),
  )

  return roSpec
}

export function buildRoSpecId(): Buffer {
  return uint32(ROSPEC_ID)
}

/**
 * SET_READER_CONFIG asking for a keepalive every `seconds`.
 *
 * Without one, a reader that has seen no tags is indistinguishable from a
 * reader whose network has gone away — and in a quiet aisle that is hours.
 */
export function buildSetReaderConfig(keepaliveSeconds: number): Buffer {
  const keepalive = tlv(
    220, // KeepaliveSpec
    Buffer.concat([Buffer.from([1]), uint32(keepaliveSeconds * 1000)]),
  )

  // ResetToFactoryDefaults = false, then the keepalive spec.
  return Buffer.concat([Buffer.from([0]), keepalive])
}

function tlv(type: number, value: Buffer): Buffer {
  const header = Buffer.alloc(4)
  header.writeUInt16BE(type & 0x3ff, 0)
  header.writeUInt16BE(4 + value.length, 2)
  return Buffer.concat([header, value])
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32BE(value, 0)
  return buffer
}

/** Builds an RO_ACCESS_REPORT body, for tests and the simulator. */
export function buildTagReport(reads: readonly LlrpTagRead[]): Buffer {
  return Buffer.concat(
    reads.map((read) => {
      const parts: Buffer[] = [
        Buffer.concat([Buffer.from([0x80 | ParameterType.EPC_96]), Buffer.from(read.epc, 'hex')]),
      ]

      if (read.antenna !== null) {
        const antenna = Buffer.alloc(3)
        antenna.writeUInt8(0x80 | ParameterType.ANTENNA_ID, 0)
        antenna.writeUInt16BE(read.antenna, 1)
        parts.push(antenna)
      }

      if (read.rssi !== null) {
        const rssi = Buffer.alloc(2)
        rssi.writeUInt8(0x80 | ParameterType.PEAK_RSSI, 0)
        rssi.writeInt8(read.rssi, 1)
        parts.push(rssi)
      }

      const timestamp = Buffer.alloc(9)
      timestamp.writeUInt8(0x80 | ParameterType.FIRST_SEEN_TIMESTAMP_UTC, 0)
      timestamp.writeBigUInt64BE(BigInt(read.at.getTime()) * 1000n, 1)
      parts.push(timestamp)

      return tlv(ParameterType.TAG_REPORT_DATA, Buffer.concat(parts))
    }),
  )
}

/** Builds an LLRPStatus parameter, for tests and the simulator. */
export function buildStatus(code: number, description = ''): Buffer {
  const text = Buffer.from(description, 'utf8')
  const value = Buffer.alloc(4 + text.length)
  value.writeUInt16BE(code, 0)
  value.writeUInt16BE(text.length, 2)
  text.copy(value, 4)

  return tlv(ParameterType.LLRP_STATUS, value)
}
