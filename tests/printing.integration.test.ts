import { randomUUID } from 'node:crypto'
import { DeviceConnection, DeviceKind, PrintJobStatus } from '@prisma/client'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listPrintJobs, splitAddress, submitPrintJob } from '@/lib/services/printing'
import { prisma, seedWarehouse, type Warehouse } from './helpers/warehouse'
import { startFakePrinter, type FakePrinter } from './helpers/fake-printer'

/**
 * The print path end to end: a template row, a registered printer, a job record
 * and the bytes that reach the socket.
 *
 * The connector tests prove the socket behaves. These prove the job is recorded
 * whatever the socket does — because a print that vanishes because the printer
 * was unreachable is a label stuck on a box with no record, and for RFID an
 * encoded tag with no trace back to its unit.
 */

let wh: Warehouse
let printer: FakePrinter | undefined
let templateId: string
let rfidTemplateId: string

const ITEM_TEMPLATE = [
  '^XA^CI28^PW812^LL406',
  '^FO30,30^A0N,40,40^FD{{itemName}}^FS',
  '^FO30,125^A0N,28,28^FDSKU {{sku}}^FS',
  '^XZ',
].join('\n')

beforeEach(async () => {
  wh = await seedWarehouse()

  await prisma.printJob.deleteMany()
  await prisma.labelTemplate.deleteMany()
  await prisma.device.deleteMany({ where: { kind: DeviceKind.PRINTER } })

  templateId = randomUUID()
  await prisma.labelTemplate.create({
    data: { id: templateId, name: 'Item label 4x2', zplBody: ITEM_TEMPLATE, rfidEncode: false },
  })

  rfidTemplateId = randomUUID()
  await prisma.labelTemplate.create({
    data: {
      id: rfidTemplateId,
      name: 'Item label 4x2 RFID',
      zplBody: ITEM_TEMPLATE,
      rfidEncode: true,
    },
  })
})

afterEach(async () => {
  await printer?.close()
  printer = undefined
})

afterAll(async () => {
  await prisma.$disconnect()
})

const actor = () => ({ userId: wh.userId })
const FIELDS = { itemName: 'Cordless drill', sku: 'TLS-0015' }

async function registerNetworkPrinter(port: number): Promise<string> {
  const id = randomUUID()
  await prisma.device.create({
    data: {
      id,
      label: 'Goods-in printer',
      kind: DeviceKind.PRINTER,
      connection: DeviceConnection.NETWORK,
      address: `127.0.0.1:${port}`,
    },
  })
  return id
}

async function registerSimulatedPrinter(): Promise<string> {
  const id = randomUUID()
  await prisma.device.create({
    data: {
      id,
      label: 'Demo printer',
      kind: DeviceKind.PRINTER,
      connection: DeviceConnection.SIMULATED,
    },
  })
  return id
}

describe('printing to a networked printer', () => {
  it('renders the template and sends it to the socket', async () => {
    printer = await startFakePrinter()
    const deviceId = await registerNetworkPrinter(printer.port)

    const result = await submitPrintJob(
      prisma,
      { templateId, printerDeviceId: deviceId, fields: FIELDS, itemId: wh.drillId },
      actor(),
    )

    expect(result.status).toBe(PrintJobStatus.SENT)
    expect(result.labels).toBe(1)
    expect(result.simulated).toBe(false)
    expect(printer.jobs[0]).toContain('^FDCordless drill^FS')
    expect(printer.jobs[0]).toContain('^FDSKU TLS-0015^FS')
  })

  it('records the job before it sends, and keeps it when the printer is off', async () => {
    // The device points at a port with nothing on it.
    const deviceId = await registerNetworkPrinter(1)

    const result = await submitPrintJob(
      prisma,
      { templateId, printerDeviceId: deviceId, fields: FIELDS, itemId: wh.drillId },
      actor(),
    )

    expect(result.status).toBe(PrintJobStatus.FAILED)
    expect(result.error).toBeTruthy()

    const stored = await prisma.printJob.findUniqueOrThrow({ where: { id: result.jobId } })
    expect(stored.status).toBe(PrintJobStatus.FAILED)
    expect(stored.sentAt).toBeNull()
    // The bytes are kept, so the job can be retried without rebuilding it.
    expect(stored.payloadZpl).toContain('Cordless drill')
  })

  it('gives every job a human-readable number', async () => {
    printer = await startFakePrinter()
    const deviceId = await registerNetworkPrinter(printer.port)

    const first = await submitPrintJob(prisma, { templateId, printerDeviceId: deviceId, fields: FIELDS }, actor())
    const second = await submitPrintJob(prisma, { templateId, printerDeviceId: deviceId, fields: FIELDS }, actor())

    expect(first.docNo).toMatch(/^PRN-\d{4}-\d{6}$/)
    expect(second.docNo).not.toBe(first.docNo)
  })

  it('sends copies as one job with ^PQ', async () => {
    printer = await startFakePrinter()
    const deviceId = await registerNetworkPrinter(printer.port)

    const result = await submitPrintJob(
      prisma,
      { templateId, printerDeviceId: deviceId, fields: FIELDS, copies: 12 },
      actor(),
    )

    expect(result.labels).toBe(12)
    expect(printer.jobs).toHaveLength(1)
    expect(printer.jobs[0]).toContain('^PQ12')
  })
})

describe('RFID encoding', () => {
  const EPC_A = '30361F49C800004000000001'
  const EPC_B = '30361F49C800004000000002'

  it('writes one label per EPC, never copies', async () => {
    // Copies repeat the same tag data, so a run of ten would encode ten tags
    // with the same EPC — ten boxes the system cannot tell apart (WADR-009).
    printer = await startFakePrinter()
    const deviceId = await registerNetworkPrinter(printer.port)

    const result = await submitPrintJob(
      prisma,
      {
        templateId: rfidTemplateId,
        printerDeviceId: deviceId,
        fields: FIELDS,
        epcs: [EPC_A, EPC_B],
        itemId: wh.drillId,
      },
      actor(),
    )

    expect(result.labels).toBe(2)
    expect(printer.jobs[0]).toContain(`^RFW,H^FD${EPC_A}^FS`)
    expect(printer.jobs[0]).toContain(`^RFW,H^FD${EPC_B}^FS`)
    expect(printer.jobs[0]).not.toContain('^PQ')
  })

  it('leaves a trail from the tag back to its unit', async () => {
    // The whole point of recording the job: an encoded tag with no record is a
    // physical object the system cannot account for.
    printer = await startFakePrinter()
    const deviceId = await registerNetworkPrinter(printer.port)

    const result = await submitPrintJob(
      prisma,
      {
        templateId: rfidTemplateId,
        printerDeviceId: deviceId,
        fields: FIELDS,
        epcs: [EPC_A],
        itemId: wh.drillId,
      },
      actor(),
    )

    const stored = await prisma.printJob.findUniqueOrThrow({ where: { id: result.jobId } })
    expect(stored.epc).toBe(EPC_A)
    expect(stored.itemId).toBe(wh.drillId)
    expect(stored.userId).toBe(wh.userId)
    expect(stored.printerDeviceId).toBe(deviceId)
  })

  it('refuses to encode through a template that is not RFID', async () => {
    // It would print labels whose tags were never written — indistinguishable
    // from encoded ones by eye, and only discovered at the next RFID count.
    const deviceId = await registerSimulatedPrinter()

    await expect(
      submitPrintJob(
        prisma,
        { templateId, printerDeviceId: deviceId, fields: FIELDS, epcs: [EPC_A] },
        actor(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('refuses an RFID template with no EPCs', async () => {
    const deviceId = await registerSimulatedPrinter()

    await expect(
      submitPrintJob(prisma, { templateId: rfidTemplateId, printerDeviceId: deviceId, fields: FIELDS }, actor()),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })
})

describe('refusals', () => {
  it('will not print a label with a missing value', async () => {
    // A blank where the SKU should be looks right and is found weeks later on an
    // unidentifiable carton.
    const deviceId = await registerSimulatedPrinter()

    await expect(
      submitPrintJob(
        prisma,
        { templateId, printerDeviceId: deviceId, fields: { itemName: 'Drill' } },
        actor(),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })

    // And nothing was recorded, because nothing was rendered.
    expect(await prisma.printJob.count()).toBe(0)
  })

  it('refuses an unknown template', async () => {
    await expect(
      submitPrintJob(prisma, { templateId: randomUUID(), fields: FIELDS }, actor()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses a retired template', async () => {
    await prisma.labelTemplate.update({ where: { id: templateId }, data: { active: false } })

    await expect(submitPrintJob(prisma, { templateId, fields: FIELDS }, actor())).rejects.toMatchObject(
      { code: 'NOT_FOUND' },
    )
  })

  it('refuses a printer that is not registered', async () => {
    await expect(
      submitPrintJob(prisma, { templateId, printerDeviceId: randomUUID(), fields: FIELDS }, actor()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('says so plainly when no printer exists at all', async () => {
    await expect(submitPrintJob(prisma, { templateId, fields: FIELDS }, actor())).rejects.toThrow(
      /No printer is set up/,
    )
  })
})

describe('the simulator', () => {
  it('prints without any hardware and says it is simulated', async () => {
    const deviceId = await registerSimulatedPrinter()

    const result = await submitPrintJob(
      prisma,
      { templateId, printerDeviceId: deviceId, fields: FIELDS },
      actor(),
    )

    expect(result.simulated).toBe(true)
    // A simulator genuinely knows the label printed, which a TCP printer does
    // not — so it may say CONFIRMED where the real one says SENT.
    expect(result.status).toBe(PrintJobStatus.CONFIRMED)
    expect(result.message).toContain('simulation')
  })

  it('is used for a printer registered with no address', async () => {
    // A misconfigured row prints into the simulator and says so on screen,
    // rather than failing with a socket error nobody on the floor can read.
    const id = randomUUID()
    await prisma.device.create({
      data: {
        id,
        label: 'Half-configured printer',
        kind: DeviceKind.PRINTER,
        connection: DeviceConnection.NETWORK,
        address: null,
      },
    })

    const result = await submitPrintJob(
      prisma,
      { templateId, printerDeviceId: id, fields: FIELDS },
      actor(),
    )

    expect(result.simulated).toBe(true)
  })
})

describe('history', () => {
  it('lists jobs newest first with who printed what', async () => {
    const deviceId = await registerSimulatedPrinter()

    await submitPrintJob(
      prisma,
      { templateId, printerDeviceId: deviceId, fields: FIELDS, itemId: wh.drillId },
      actor(),
    )

    const [job] = await listPrintJobs(prisma, { itemId: wh.drillId })

    expect(job?.template.name).toBe('Item label 4x2')
    expect(job?.printerDevice?.label).toBe('Demo printer')
    expect(job?.user?.name).toBe('Tester')
  })
})

describe('splitAddress', () => {
  it('reads host and port', () => {
    expect(splitAddress('10.0.0.5:9100')).toEqual(['10.0.0.5', 9100])
  })

  it('defaults the port when there is none', () => {
    expect(splitAddress('printer.local')).toEqual(['printer.local', undefined])
  })

  it('does not mistake a hostname for a port', () => {
    expect(splitAddress('printer.local:not-a-port')).toEqual(['printer.local:not-a-port', undefined])
  })
})
