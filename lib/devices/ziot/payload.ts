import type { LlrpTagRead } from '../llrp/protocol'

/**
 * Zebra IoT Connector tag-read payloads.
 *
 * ZIoT is firmware on an FX7500/FX9600 that publishes tag reads as JSON rather
 * than making us speak LLRP. It can send them over MQTT, WebSocket or plain
 * HTTP POST, and which of those a site uses depends on its network — that is an
 * open question for bring-up (DEVICE_INTEGRATION §9, Q7).
 *
 * So the transport is deliberately NOT decided here. This module is the part
 * that is the same whichever way the bytes arrive, and the part that would be
 * wrong: reading Zebra's JSON into the `LlrpTagRead` shape the rest of the
 * system already understands, so a ZIoT reader and an LLRP reader are
 * indistinguishable upstream.
 *
 * Pure, so it can be tested against recorded-shape payloads without a reader.
 */

export class ZiotPayloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZiotPayloadError'
  }
}

/**
 * What a ZIoT reader sends.
 *
 * Every field is optional because the firmware's "data format" setting decides
 * which are included, and a site may have it set either way. Only the EPC is
 * genuinely required — a read without one identifies nothing.
 */
interface ZiotEvent {
  type?: string
  timestamp?: string | number
  data?: {
    idHex?: string
    epc?: string
    antenna?: number
    peakRssi?: number
    rssi?: number
    format?: string
  }
  // Flattened form, which some firmware versions emit instead.
  idHex?: string
  epc?: string
  antenna?: number
  peakRssi?: number
  reader?: string
}

export interface ZiotReadResult {
  reads: LlrpTagRead[]
  /** Entries we could not read, with why. Reported, never silently dropped. */
  skipped: string[]
  /** The reader's own name, when it sends one. */
  reader: string | null
}

/**
 * Parses a ZIoT payload, which may be one event or an array of them.
 *
 * Tolerant by design and loud about what it drops. A reader firmware upgrade
 * that adds a field must not stop a cycle count, but an entry we cannot read is
 * a tag that was physically present and is about to be counted as missing — so
 * it is reported rather than swallowed.
 */
export function readZiotPayload(input: unknown, now: Date = new Date()): ZiotReadResult {
  const events = normalise(input)
  const reads: LlrpTagRead[] = []
  const skipped: string[] = []
  let reader: string | null = null

  for (const [index, event] of events.entries()) {
    if (typeof event !== 'object' || event === null) {
      skipped.push(`entry ${index} is not an object`)
      continue
    }

    const item = event as ZiotEvent
    reader ??= typeof item.reader === 'string' ? item.reader : null

    // ZIoT sends several event types on one stream; only tag reads matter here.
    if (item.type && !/^SIMPLE|^tag|read/i.test(item.type)) {
      skipped.push(`entry ${index} is a "${item.type}" event, not a tag read`)
      continue
    }

    const epc = epcOf(item)
    if (!epc) {
      skipped.push(`entry ${index} carries no EPC`)
      continue
    }
    if (!/^[0-9A-F]+$/.test(epc) || epc.length % 2 !== 0) {
      // A malformed EPC would never match a unit, and silently keeping it would
      // show up later as a mystery "unknown tag" on the count.
      skipped.push(`entry ${index} has an EPC that is not hex: ${epc.slice(0, 32)}`)
      continue
    }

    reads.push({
      epc,
      antenna: numberOf(item.data?.antenna ?? item.antenna),
      rssi: rssiOf(item),
      at: timestampOf(item.timestamp) ?? now,
    })
  }

  return { reads, skipped, reader }
}

function normalise(input: unknown): unknown[] {
  if (Array.isArray(input)) return input
  if (typeof input === 'string') {
    try {
      return normalise(JSON.parse(input))
    } catch {
      throw new ZiotPayloadError('That payload is not JSON.')
    }
  }
  if (typeof input === 'object' && input !== null) {
    // Some firmware wraps the batch in an envelope.
    const wrapped = (input as { data?: unknown }).data
    if (Array.isArray(wrapped)) return wrapped
    return [input]
  }

  throw new ZiotPayloadError('That payload is not a tag read.')
}

function epcOf(item: ZiotEvent): string | null {
  const raw = item.data?.idHex ?? item.data?.epc ?? item.idHex ?? item.epc
  return typeof raw === 'string' && raw.length > 0 ? raw.trim().toUpperCase() : null
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function rssiOf(item: ZiotEvent): number | null {
  const raw = item.data?.peakRssi ?? item.data?.rssi ?? item.peakRssi
  const value = numberOf(raw)
  if (value === null) return null

  // ZIoT reports dBm, already negative. A positive value means the firmware is
  // sending an unsigned figure, and reporting it as-is would put "+52 dBm" on a
  // screen — a number that looks real and is not.
  return value > 0 ? -value : value
}

function timestampOf(value: string | number | undefined): Date | null {
  if (value === undefined) return null

  // Epoch milliseconds, epoch microseconds, or an ISO string, depending on the
  // firmware's clock format setting.
  if (typeof value === 'number') {
    const ms = value > 1e14 ? value / 1000 : value
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? null : date
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}
