import { randomUUID } from 'node:crypto'
import { DeviceConnection, DeviceKind } from '@prisma/client'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  STALE_AFTER_MINUTES,
  isSimulated,
  listDevices,
  registerDevice,
  retireDevice,
  runSelfTest,
} from '@/lib/services/devices'
import { prisma, seedWarehouse, type Warehouse } from './helpers/warehouse'

/**
 * The test database is neither LIVE nor DEMO, so each test says which it means.
 *
 * LIVE for the tests that exercise a REAL connector against a local double —
 * the double stands in for hardware, and DEMO would substitute the simulator
 * and never open the socket. DEMO for the tests that exercise the simulator.
 */
const LIVE = 'LIVE' as const
const DEMO = 'DEMO' as const
import { startFakePrinter, type FakePrinter } from './helpers/fake-printer'
import { startFakeLlrpReader, type FakeLlrpReader } from './helpers/fake-llrp-reader'

/**
 * The device registry and its self-tests.
 *
 * The self-test is what somebody runs on hardware day, so what it SAYS matters
 * as much as whether it passes — "the socket opened but ~HS timed out" tells
 * them which cable to look at; a red cross tells them to open a ticket.
 */

let wh: Warehouse
let printer: FakePrinter | undefined
let reader: FakeLlrpReader | undefined

beforeEach(async () => {
  wh = await seedWarehouse()
  await prisma.device.deleteMany()
})

afterEach(async () => {
  await printer?.close()
  await reader?.close()
  printer = undefined
  reader = undefined
})

afterAll(async () => {
  await prisma.$disconnect()
})

describe('the registry', () => {
  it('registers a networked printer', async () => {
    const device = await registerDevice(prisma, {
      label: 'Goods-in printer',
      kind: DeviceKind.PRINTER,
      connection: DeviceConnection.NETWORK,
      address: '10.0.0.5:9100',
      vendor: 'Zebra',
      model: 'ZD621R',
      siteId: wh.siteId,
    })

    expect(device.simulated).toBe(false)
    expect(device.siteCode).toBe('TEST')
  })

  it('refuses a networked device with no address', async () => {
    // Without one there is nothing to connect to, and the failure would surface
    // later as a socket error nobody on the floor can interpret.
    await expect(
      registerDevice(prisma, {
        label: 'Nowhere printer',
        kind: DeviceKind.PRINTER,
        connection: DeviceConnection.NETWORK,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('treats a device with no address as a simulation', async () => {
    // Derived, not stored. A half-configured printer prints into the simulator
    // and says "Simulation" on screen rather than failing obscurely.
    expect(isSimulated({ connection: DeviceConnection.NETWORK, address: null })).toBe(true)
    expect(isSimulated({ connection: DeviceConnection.SIMULATED, address: null })).toBe(true)
    expect(isSimulated({ connection: DeviceConnection.NETWORK, address: '10.0.0.5' })).toBe(false)
  })

  it('reports how long a device has been quiet', async () => {
    const id = randomUUID()
    await prisma.device.create({
      data: {
        id,
        label: 'Old handset',
        kind: DeviceKind.MOBILE_COMPUTER,
        lastSeenAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      },
    })

    const [device] = await listDevices(prisma, { kind: DeviceKind.MOBILE_COMPUTER })

    expect(device?.quietForMinutes).toBeGreaterThan(STALE_AFTER_MINUTES)
  })

  it('distinguishes never-heard-from from long-quiet', async () => {
    // A networked printer says nothing until something is sent to it, so
    // "never" is not a fault. Collapsing the two would flag every new printer.
    await registerDevice(prisma, {
      label: 'New printer',
      kind: DeviceKind.PRINTER,
      connection: DeviceConnection.NETWORK,
      address: '10.0.0.9',
    })

    const [device] = await listDevices(prisma, { kind: DeviceKind.PRINTER })
    expect(device?.quietForMinutes).toBeNull()
  })

  it('retires rather than deletes', async () => {
    // Movements and print jobs point at the device. Deleting the row breaks the
    // answer to "which scanner recorded this?", which is why the column exists.
    const device = await registerDevice(prisma, {
      label: 'Broken scanner',
      kind: DeviceKind.SCANNER,
      connection: DeviceConnection.BLUETOOTH,
      address: 'AA:BB:CC:DD:EE:FF',
    })

    await retireDevice(prisma, device.id)

    expect(await listDevices(prisma)).toHaveLength(0)
    expect(await listDevices(prisma, { includeRetired: true })).toHaveLength(1)
    expect(await prisma.device.count()).toBe(1)
  })
})

describe('self-testing a printer', () => {
  it('walks the bring-up steps against a real socket', async () => {
    printer = await startFakePrinter()
    const device = await registerDevice(prisma, {
      label: 'Goods-in printer',
      kind: DeviceKind.PRINTER,
      connection: DeviceConnection.NETWORK,
      address: `127.0.0.1:${printer.port}`,
    })

    const report = await runSelfTest(prisma, device.id, LIVE)

    expect(report.ok).toBe(true)
    expect(report.steps.map((s) => s.name)).toEqual([
      'Open socket',
      'Query status (~HS)',
      'Print a test label',
    ])
    expect(printer.jobs.some((job) => job.includes('Inventory test label'))).toBe(true)
  })

  it('says which step failed and why', async () => {
    const device = await registerDevice(prisma, {
      label: 'Unplugged printer',
      kind: DeviceKind.PRINTER,
      connection: DeviceConnection.NETWORK,
      address: '127.0.0.1:1',
    })

    const report = await runSelfTest(prisma, device.id, LIVE)

    expect(report.ok).toBe(false)
    expect(report.steps).toHaveLength(1)
    expect(report.steps[0]?.detail.length).toBeGreaterThan(20)
  })

  it('records contact only when the test passed', async () => {
    // A self-test IS contact with the device. A failing one must not refresh
    // lastSeenAt, or a dead printer looks freshly alive on the list.
    const device = await registerDevice(prisma, {
      label: 'Unplugged printer',
      kind: DeviceKind.PRINTER,
      connection: DeviceConnection.NETWORK,
      address: '127.0.0.1:1',
    })

    await runSelfTest(prisma, device.id, LIVE)
    expect(
      (await prisma.device.findUniqueOrThrow({ where: { id: device.id } })).lastSeenAt,
    ).toBeNull()

    printer = await startFakePrinter()
    await prisma.device.update({
      where: { id: device.id },
      data: { address: `127.0.0.1:${printer.port}` },
    })

    await runSelfTest(prisma, device.id, LIVE)
    expect(
      (await prisma.device.findUniqueOrThrow({ where: { id: device.id } })).lastSeenAt,
    ).not.toBeNull()
  })

  it('uses the simulator for a printer with no address', async () => {
    const device = await registerDevice(prisma, {
      label: 'Demo printer',
      kind: DeviceKind.PRINTER,
      connection: DeviceConnection.SIMULATED,
    })

    const report = await runSelfTest(prisma, device.id, LIVE)

    expect(report.ok).toBe(true)
    expect(report.steps[0]?.detail).toMatch(/simulated/i)
  })
})

describe('self-testing an RFID reader', () => {
  it('runs the LLRP bring-up against a real reader socket', async () => {
    reader = await startFakeLlrpReader()
    const device = await registerDevice(prisma, {
      label: 'Aisle A reader',
      kind: DeviceKind.RFID_READER,
      connection: DeviceConnection.NETWORK,
      address: `127.0.0.1:${reader.port}`,
    })

    const report = await runSelfTest(prisma, device.id, LIVE)

    expect(report.steps.map((s) => s.name)).toEqual([
      'Connect',
      'Read capabilities',
      'Inventory for 5 seconds',
    ])
    // No tagged stock in front of a test double, so the honest answer is none —
    // and it must say what to go and check rather than just failing.
    expect(report.steps[2]?.detail).toMatch(/no tags/i)
  }, 20_000)

  it('uses the simulator when there is no address', async () => {
    const device = await registerDevice(prisma, {
      label: 'Demo reader',
      kind: DeviceKind.RFID_READER,
      connection: DeviceConnection.SIMULATED,
    })

    const report = await runSelfTest(prisma, device.id, LIVE)

    expect(report.ok).toBe(true)
    expect(report.steps[2]?.detail).toMatch(/simulation/)
  })
})

describe('self-testing what the server cannot reach', () => {
  it('says a scanner cannot be tested from the server', async () => {
    // A scanner connects to the BROWSER. A green tick here would be a lie, and
    // a red cross would send somebody looking for a fault that is not there.
    const device = await registerDevice(prisma, {
      label: 'Ring scanner',
      kind: DeviceKind.SCANNER,
      connection: DeviceConnection.BLUETOOTH,
      address: 'AA:BB:CC:DD:EE:FF',
    })

    const report = await runSelfTest(prisma, device.id, LIVE)

    expect(report.steps[0]?.detail).toMatch(/browser/i)
    expect(report.steps[0]?.detail).toMatch(/Scan/)
  })

  it('refuses to test a retired device', async () => {
    const device = await registerDevice(prisma, {
      label: 'Old printer',
      kind: DeviceKind.PRINTER,
      connection: DeviceConnection.SIMULATED,
    })
    await retireDevice(prisma, device.id)

    await expect(runSelfTest(prisma, device.id, LIVE)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    })
  })

  it('refuses an unknown device', async () => {
    await expect(runSelfTest(prisma, randomUUID(), LIVE)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})
