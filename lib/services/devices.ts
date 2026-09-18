import 'server-only'
import { DeviceConnection, DeviceKind } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import type { SelfTestReport } from '@/lib/devices/printer'
import { SimulatedPrinter } from '@/lib/devices/simulated/printer'
import { SimulatedRfidReader } from '@/lib/devices/simulated/rfid-reader'
import { TcpPrinter } from '@/lib/devices/server/tcp-printer'
import { LlrpReader } from '@/lib/devices/server/llrp-reader'
import { publishDevice } from '@/lib/events/publish'
import { modeOf } from '@/lib/mode'
import { splitAddress } from './printing'

/**
 * The device registry.
 *
 * One table, shared by both clients, answering what a warehouse manager
 * actually asks: what hardware do we have, where is it, who has it, is it
 * working, and which device recorded this movement (DEVICE_INTEGRATION §7).
 */

export interface DeviceRow {
  id: string
  label: string
  kind: DeviceKind
  connection: DeviceConnection
  address: string | null
  vendor: string | null
  model: string | null
  firmware: string | null
  appVersion: string | null
  assignedTo: string | null
  siteCode: string | null
  lastSeenAt: Date | null
  active: boolean
  /** True when this device is a stand-in, so the UI can say so. Always. */
  simulated: boolean
  /** Minutes since we last heard from it, or null if never. */
  quietForMinutes: number | null
}

/**
 * How long a device may go unheard-from before it is worth asking about.
 *
 * Generous on purpose: a handset on a charger overnight is not a fault, and a
 * list that cries wolf every morning is a list nobody reads.
 */
export const STALE_AFTER_MINUTES = 12 * 60

export async function listDevices(
  db: PrismaClient,
  filter: { kind?: DeviceKind; includeRetired?: boolean } = {},
  now: Date = new Date(),
): Promise<DeviceRow[]> {
  const devices = await db.device.findMany({
    where: {
      ...(filter.kind ? { kind: filter.kind } : {}),
      ...(filter.includeRetired ? {} : { active: true }),
    },
    select: {
      id: true,
      label: true,
      kind: true,
      connection: true,
      address: true,
      vendor: true,
      model: true,
      firmware: true,
      appVersion: true,
      lastSeenAt: true,
      active: true,
      assignedUser: { select: { name: true } },
      site: { select: { code: true } },
    },
    orderBy: [{ kind: 'asc' }, { label: 'asc' }],
  })

  return devices.map((device) => ({
    id: device.id,
    label: device.label,
    kind: device.kind,
    connection: device.connection,
    address: device.address,
    vendor: device.vendor,
    model: device.model,
    firmware: device.firmware,
    appVersion: device.appVersion,
    assignedTo: device.assignedUser?.name ?? null,
    siteCode: device.site?.code ?? null,
    lastSeenAt: device.lastSeenAt,
    active: device.active,
    simulated: isSimulated(device),
    quietForMinutes: device.lastSeenAt
      ? Math.floor((now.getTime() - device.lastSeenAt.getTime()) / 60_000)
      : null,
  }))
}

/**
 * A device with no address is a stand-in, whatever its connection says.
 *
 * Deliberately derived rather than stored: a half-configured NETWORK printer
 * would otherwise claim to be real and fail with a socket error nobody on the
 * floor can interpret. This way it prints into the simulator and says so.
 */
export function isSimulated(device: {
  connection: DeviceConnection
  address: string | null
}): boolean {
  return device.connection === DeviceConnection.SIMULATED || !device.address
}

export async function deviceById(db: PrismaClient, id: string): Promise<DeviceRow> {
  const [device] = await listDevices(db, { includeRetired: true }).then((rows) =>
    rows.filter((row) => row.id === id),
  )
  if (!device) throw new ApiError(ErrorCode.NOT_FOUND, 'That device is not registered.')
  return device
}

/**
 * Runs the device's own bring-up sequence and returns what happened at each
 * step.
 *
 * A report, not a boolean. On hardware day the useful answer is "the socket
 * opened but ~HS timed out", which tells somebody what to go and look at
 * (DEVICE_INTEGRATION §11.3).
 */
export async function runSelfTest(db: PrismaClient, deviceId: string): Promise<SelfTestReport> {
  const device = await deviceById(db, deviceId)

  if (!device.active) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      `"${device.label}" has been retired. Reactivate it before testing.`,
    )
  }

  const report = await selfTestFor(device)

  // A self-test IS contact with the device, so a passing one updates lastSeenAt
  // and a failing one deliberately does not.
  if (report.ok) {
    await db.device.update({ where: { id: deviceId }, data: { lastSeenAt: new Date() } })
  }

  publishDevice({
    mode: modeOf(db),
    siteId: null,
    device: device.label,
    detail: report.ok
      ? 'self-test passed'
      : `self-test failed at ${report.steps.find((step) => !step.ok)?.name ?? 'an early step'}`,
    ok: report.ok,
  })

  return report
}

async function selfTestFor(device: DeviceRow): Promise<SelfTestReport> {
  if (device.simulated) {
    switch (device.kind) {
      case DeviceKind.PRINTER:
        return new SimulatedPrinter(device.label).selfTest()
      case DeviceKind.RFID_READER: {
        const reader = new SimulatedRfidReader({ label: device.label })
        // Nothing loaded: an honest "saw 0 of 0" rather than invented tags. The
        // count screens load real EPCs before sweeping.
        return reader.selfTest()
      }
      default:
        return {
          device: device.label,
          ok: true,
          steps: [
            {
              name: 'Connect',
              ok: true,
              detail:
                'Simulated — this device is a stand-in. A scanner proves itself by scanning; open Scan and use the simulator there.',
              ms: 0,
            },
          ],
        }
    }
  }

  const [host, port] = splitAddress(device.address!)

  switch (device.kind) {
    case DeviceKind.PRINTER:
      return new TcpPrinter({ host, port, label: device.label }).selfTest()
    case DeviceKind.RFID_READER:
      return new LlrpReader({ host, port, label: device.label }).selfTest()
    default:
      // Scanners reach the browser, not the server, so the server cannot test
      // one. Saying so beats a green tick that means nothing.
      return {
        device: device.label,
        ok: false,
        steps: [
          {
            name: 'Connect',
            ok: false,
            detail:
              'A scanner connects to the browser, not to the server, so it cannot be tested from here. Open Scan and trigger a read.',
            ms: 0,
          },
        ],
      }
  }
}

export interface RegisterDeviceInput {
  label: string
  kind: DeviceKind
  connection: DeviceConnection
  address?: string | null
  vendor?: string | null
  model?: string | null
  serial?: string | null
  siteId?: string | null
}

export async function registerDevice(
  db: PrismaClient,
  input: RegisterDeviceInput,
): Promise<DeviceRow> {
  if (input.connection === DeviceConnection.NETWORK && !input.address?.trim()) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      'A networked device needs an address, as host or host:port.',
    )
  }

  const device = await db.device.create({
    data: {
      id: crypto.randomUUID(),
      label: input.label.trim(),
      kind: input.kind,
      connection: input.connection,
      address: input.address?.trim() || null,
      vendor: input.vendor?.trim() || null,
      model: input.model?.trim() || null,
      serial: input.serial?.trim() || null,
      siteId: input.siteId || null,
    },
  })

  return deviceById(db, device.id)
}

/**
 * Retires a device rather than deleting it.
 *
 * Movements and print jobs point at it. Deleting the row would break the answer
 * to "which scanner recorded this?", which is the whole reason the column
 * exists.
 */
export async function retireDevice(db: PrismaClient, id: string): Promise<void> {
  await db.device.update({ where: { id }, data: { active: false } })
}

export async function reactivateDevice(db: PrismaClient, id: string): Promise<void> {
  await db.device.update({ where: { id }, data: { active: true } })
}
