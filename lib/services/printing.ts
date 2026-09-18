import 'server-only'
import { randomUUID } from 'node:crypto'
import { DeviceConnection, DeviceKind, PrintJobStatus } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { ApiError, ErrorCode } from '@/lib/api/errors'
import { PrintOutcome, type PrinterConnector, type PrintResult } from '@/lib/devices/printer'
import { SimulatedPrinter } from '@/lib/devices/simulated/printer'
import { TcpPrinter } from '@/lib/devices/server/tcp-printer'
import {
  ZplError,
  labelCount,
  placeholdersIn,
  renderTemplate,
  withCopies,
  withRfidEncoding,
  type LabelFields,
} from '@/lib/labels/zpl'
import { allocateDocNo } from './numbering'

/**
 * One print path for both clients (WADR-014).
 *
 * The web app and the phone both post here; the server renders the label from a
 * template row, records the job, and hands the bytes to whichever connector the
 * chosen printer needs. Neither client knows whether it printed over TCP, over
 * Browser Print or into a simulator.
 *
 * Every job is recorded BEFORE it is sent, and updated after. A job that vanishes
 * because the printer was unreachable is a label somebody stuck on a box with no
 * record of it — and for RFID, an encoded tag with no trace back to its unit,
 * which is the one thing the serial design exists to prevent (ARCHITECTURE §5.4).
 */

export interface PrintRequest {
  templateId: string
  printerDeviceId?: string | null
  copies?: number
  /** Values for the template's placeholders. */
  fields?: LabelFields
  /** One label per EPC, each encoding its own tag. Requires an RFID template. */
  epcs?: string[]
  itemId?: string | null
  batchId?: string | null
  serialUnitId?: string | null
  locationId?: string | null
}

export interface PrintJobResult {
  jobId: string
  docNo: string
  status: PrintJobStatus
  labels: number
  printer: string
  simulated: boolean
  message: string
  error?: string
  /** The bytes that were sent, so a client can preview exactly what printed. */
  zpl: string
}

export async function submitPrintJob(
  db: PrismaClient,
  request: PrintRequest,
  actor: { userId: string },
): Promise<PrintJobResult> {
  const template = await db.labelTemplate.findUnique({ where: { id: request.templateId } })
  if (!template || !template.active) {
    throw new ApiError(ErrorCode.NOT_FOUND, 'That label template does not exist, or is retired.')
  }

  const zpl = buildZpl(template, request)
  const { connector, deviceId } = await resolvePrinter(db, request.printerDeviceId ?? null)

  // Recorded first, as QUEUED. If the process dies between here and the socket,
  // the job is visible as unfinished rather than absent.
  const { jobId, docNo } = await db.$transaction(async (tx) => {
    const docNo = await allocateDocNo(tx, 'PRINT')
    const jobId = randomUUID()

    await tx.printJob.create({
      data: {
        id: jobId,
        docNo,
        templateId: template.id,
        printerDeviceId: deviceId,
        payloadZpl: zpl,
        copies: request.copies ?? 1,
        status: PrintJobStatus.QUEUED,
        itemId: request.itemId ?? null,
        batchId: request.batchId ?? null,
        serialUnitId: request.serialUnitId ?? null,
        locationId: request.locationId ?? null,
        // Only one EPC fits the column. A multi-tag run records the first, and
        // the full set is recoverable from payloadZpl.
        epc: request.epcs?.[0]?.toUpperCase() ?? null,
        userId: actor.userId,
      },
    })

    return { jobId, docNo }
  })

  const result = await connector.print(zpl)

  await db.printJob.update({
    where: { id: jobId },
    data: {
      status: statusFor(result),
      error: result.error ?? null,
      sentAt: result.outcome === PrintOutcome.FAILED ? null : new Date(),
    },
  })

  return {
    jobId,
    docNo,
    status: statusFor(result),
    labels: result.labels,
    printer: connector.label,
    simulated: connector.simulated,
    message: result.message,
    error: result.error,
    zpl,
  }
}

function statusFor(result: PrintResult): PrintJobStatus {
  switch (result.outcome) {
    case PrintOutcome.CONFIRMED:
      return PrintJobStatus.CONFIRMED
    case PrintOutcome.SENT:
      return PrintJobStatus.SENT
    case PrintOutcome.FAILED:
      return PrintJobStatus.FAILED
  }
}

function buildZpl(
  template: { zplBody: string; rfidEncode: boolean; name: string },
  request: PrintRequest,
): string {
  let zpl: string
  try {
    zpl = renderTemplate(template.zplBody, request.fields ?? {})
  } catch (error) {
    if (error instanceof ZplError) {
      throw new ApiError(ErrorCode.VALIDATION_FAILED, error.message, { template: template.name })
    }
    throw error
  }

  const epcs = request.epcs ?? []

  if (epcs.length > 0) {
    if (!template.rfidEncode) {
      // Sending ^RFW to a template meant for plain stock prints labels whose
      // tags were never written — indistinguishable from encoded ones by eye.
      throw new ApiError(
        ErrorCode.VALIDATION_FAILED,
        `"${template.name}" is not an RFID template, so it cannot encode tags. Choose an RFID label.`,
      )
    }

    try {
      return withRfidEncoding(zpl, epcs)
    } catch (error) {
      throw new ApiError(
        ErrorCode.VALIDATION_FAILED,
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  if (template.rfidEncode) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      `"${template.name}" encodes RFID tags, so it needs an EPC for every label. Allocate a serial block first.`,
    )
  }

  try {
    return withCopies(zpl, request.copies ?? 1)
  } catch (error) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      error instanceof Error ? error.message : String(error),
    )
  }
}

/**
 * Picks the connector for a printer.
 *
 * A device with no network address is a simulator, whatever else it says. That
 * is deliberate: a misconfigured printer row prints into the simulator and says
 * "(simulation)" on screen, rather than failing with a socket error nobody on
 * the floor can interpret.
 */
export async function resolvePrinter(
  db: PrismaClient,
  printerDeviceId: string | null,
): Promise<{ connector: PrinterConnector; deviceId: string | null }> {
  if (!printerDeviceId) {
    const fallback = await db.device.findFirst({
      where: { kind: DeviceKind.PRINTER, active: true },
      orderBy: [{ connection: 'asc' }, { createdAt: 'asc' }],
    })

    if (!fallback) {
      throw new ApiError(
        ErrorCode.NOT_FOUND,
        'No printer is set up yet. Add one under Admin → Devices, or run in Demo mode to use the simulator.',
      )
    }
    return { connector: connectorFor(fallback), deviceId: fallback.id }
  }

  const device = await db.device.findUnique({ where: { id: printerDeviceId } })
  if (!device || device.kind !== DeviceKind.PRINTER) {
    throw new ApiError(ErrorCode.NOT_FOUND, 'That printer is not registered.')
  }
  if (!device.active) {
    throw new ApiError(ErrorCode.VALIDATION_FAILED, `"${device.label}" has been retired.`)
  }

  return { connector: connectorFor(device), deviceId: device.id }
}

export function connectorFor(device: {
  label: string
  connection: DeviceConnection
  address: string | null
}): PrinterConnector {
  if (device.connection === DeviceConnection.NETWORK && device.address) {
    const [host, port] = splitAddress(device.address)
    return new TcpPrinter({ host, port, label: device.label })
  }

  return new SimulatedPrinter(device.label)
}

/** `host` or `host:port`. */
export function splitAddress(address: string): [string, number | undefined] {
  const index = address.lastIndexOf(':')
  if (index === -1) return [address, undefined]

  const port = Number.parseInt(address.slice(index + 1), 10)
  if (!Number.isFinite(port) || port <= 0 || port > 65_535) return [address, undefined]

  return [address.slice(0, index), port]
}

/**
 * Fills the fields a template asks for, from whatever it is being printed for.
 *
 * The template declares what it needs through its placeholders and this
 * supplies them, so adding a field to a label is a database edit rather than a
 * code change (WADR-014). A placeholder nothing here knows about is left unset,
 * and `renderTemplate` then refuses the job by name — which is the right
 * failure, because the alternative is a label with a blank where the SKU
 * should be.
 */
export async function labelFieldsFor(
  db: PrismaClient,
  input: { templateId: string; itemId?: string | null; batchId?: string | null; locationId?: string | null },
): Promise<{ fields: LabelFields; missing: string[] }> {
  const template = await db.labelTemplate.findUnique({
    where: { id: input.templateId },
    select: { zplBody: true },
  })
  if (!template) throw new ApiError(ErrorCode.NOT_FOUND, 'That label template does not exist.')

  const [item, batch, location] = await Promise.all([
    input.itemId
      ? db.item.findUnique({
          where: { id: input.itemId },
          select: {
            sku: true,
            name: true,
            unit: true,
            barcodes: { select: { barcode: true, type: true, isPrimary: true } },
          },
        })
      : null,
    input.batchId
      ? db.batch.findUnique({
          where: { id: input.batchId },
          select: { batchNo: true, expiryDate: true, mfgDate: true },
        })
      : null,
    input.locationId
      ? db.location.findUnique({ where: { id: input.locationId }, select: { code: true, name: true } })
      : null,
  ])

  const ean13 = item?.barcodes.find((barcode) => barcode.type === 'EAN13' && barcode.isPrimary)
    ?? item?.barcodes.find((barcode) => barcode.type === 'EAN13')

  const fields: LabelFields = {
    itemName: item?.name,
    sku: item?.sku,
    unit: item?.unit,
    barcode: ean13?.barcode,
    // ^BE makes the printer compute the check digit, so it is given twelve.
    barcode12: ean13?.barcode.slice(0, 12),
    batchNo: batch?.batchNo,
    expiryDate: batch?.expiryDate ? isoDate(batch.expiryDate) : undefined,
    mfgDate: batch?.mfgDate ? isoDate(batch.mfgDate) : undefined,
    location: location?.code,
    code: location?.code,
    locationName: location?.name,
    printedOn: isoDate(new Date()),
  }

  const missing = placeholdersIn(template.zplBody).filter((name) => {
    const value = fields[name]
    return value === null || value === undefined || value === ''
  })

  return { fields, missing }
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Print history, newest first — the audit trail for every physical tag. */
export async function listPrintJobs(
  db: PrismaClient,
  filter: { itemId?: string; status?: PrintJobStatus; limit?: number } = {},
) {
  return db.printJob.findMany({
    where: {
      ...(filter.itemId ? { itemId: filter.itemId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
    },
    select: {
      id: true,
      docNo: true,
      status: true,
      copies: true,
      epc: true,
      error: true,
      createdAt: true,
      sentAt: true,
      template: { select: { name: true, kind: true } },
      printerDevice: { select: { label: true } },
      item: { select: { sku: true, name: true } },
      user: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(filter.limit ?? 50, 1), 200),
  })
}

/** Labels a request will produce, for confirming before a long run. */
export function labelsIn(zpl: string): number {
  return labelCount(zpl)
}
