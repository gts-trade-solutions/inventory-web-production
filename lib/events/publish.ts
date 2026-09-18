import 'server-only'
import { EventKind, events } from './bus'
import type { AppMode } from '@/lib/mode'

/**
 * The things worth putting on a live console, in the words somebody watching
 * one would use.
 *
 * Publishing must never fail the operation that triggered it. A console line is
 * a convenience; a stock movement is work somebody physically did. Every
 * function here swallows its own errors for that reason.
 */

function safely(publish: () => void): void {
  try {
    publish()
  } catch {
    // Deliberately silent. Nothing upstream should change because a console is
    // or is not listening.
  }
}

export function publishMovement(input: {
  mode: AppMode
  siteId: string
  docNo: string
  type: string
  quantity: number
  itemName: string
  from: string | null
  to: string | null
  deviceLabel?: string | null
}): void {
  safely(() => {
    const where =
      input.from && input.to
        ? `${input.from} → ${input.to}`
        : input.to
          ? `into ${input.to}`
          : input.from
            ? `from ${input.from}`
            : ''

    events.publish({
      kind: EventKind.MOVEMENT,
      mode: input.mode,
      siteId: input.siteId,
      summary: `${input.docNo} · ${input.type.toLowerCase()} ${input.quantity} × ${input.itemName} ${where}`.trim(),
      data: {
        docNo: input.docNo,
        type: input.type,
        quantity: input.quantity,
        device: input.deviceLabel ?? null,
      },
    })
  })
}

export function publishTagReads(input: {
  mode: AppMode
  siteId: string
  sessionId: string
  device: string
  simulated: boolean
  distinctTags: number
  newToSession: number
  unknownEpcs: number
}): void {
  safely(() => {
    events.publish({
      kind: EventKind.TAG_READ,
      mode: input.mode,
      siteId: input.siteId,
      summary: `${input.device} read ${input.distinctTags} tag${
        input.distinctTags === 1 ? '' : 's'
      }, ${input.newToSession} new${input.simulated ? ' (simulation)' : ''}`,
      data: {
        sessionId: input.sessionId,
        simulated: input.simulated,
        unknownEpcs: input.unknownEpcs,
      },
    })
  })
}

export function publishCount(input: {
  mode: AppMode
  siteId: string
  docNo: string
  status: string
  location: string
  detail?: string
}): void {
  safely(() => {
    events.publish({
      kind: EventKind.COUNT,
      mode: input.mode,
      siteId: input.siteId,
      summary: `${input.docNo} · ${input.status.toLowerCase()} at ${input.location}${
        input.detail ? ` — ${input.detail}` : ''
      }`,
      data: { docNo: input.docNo, status: input.status },
    })
  })
}

export function publishPrint(input: {
  mode: AppMode
  siteId: string | null
  docNo: string
  printer: string
  simulated: boolean
  labels: number
  status: string
  epc?: string | null
}): void {
  safely(() => {
    events.publish({
      kind: EventKind.PRINT,
      mode: input.mode,
      siteId: input.siteId,
      summary: `${input.docNo} · ${input.labels} label${input.labels === 1 ? '' : 's'} ${
        input.status.toLowerCase()
      } to ${input.printer}${input.simulated ? ' (simulation)' : ''}`,
      data: { docNo: input.docNo, status: input.status, epc: input.epc ?? null },
    })
  })
}

export function publishDevice(input: {
  mode: AppMode
  siteId: string | null
  device: string
  detail: string
  ok: boolean
}): void {
  safely(() => {
    events.publish({
      kind: EventKind.DEVICE,
      mode: input.mode,
      siteId: input.siteId,
      summary: `${input.device} · ${input.detail}`,
      data: { ok: input.ok },
    })
  })
}
