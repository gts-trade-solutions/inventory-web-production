import { DeviceConnection } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { connectorFor } from '@/lib/services/printing'
import { SimulatedPrinter } from '@/lib/devices/simulated/printer'
import { TcpPrinter } from '@/lib/devices/server/tcp-printer'

/**
 * The device-binding guardrail (DEMO_MODE §7.3).
 *
 * "Real devices are unreachable in Demo mode, and simulators are unreachable in
 * Live mode." These are requirements, not conventions: getting either wrong
 * once destroys trust in the whole system, and neither failure announces
 * itself.
 *
 * Kept as its own file because this is a rule about the product, not about the
 * printing feature — it should be the thing that breaks if somebody adds a
 * connector and forgets which mode it belongs to.
 */

const networked = {
  label: 'Goods-in printer',
  connection: DeviceConnection.NETWORK,
  address: '10.0.0.5:9100',
}

const simulated = {
  label: 'Demo printer',
  connection: DeviceConnection.SIMULATED,
  address: null,
}

describe('in DEMO mode', () => {
  it('never reaches a real printer, whatever the row says', () => {
    // A demo device row carrying a real address is a configuration mistake, not
    // permission to print on the warehouse printer.
    const connector = connectorFor(networked, 'DEMO')

    expect(connector).toBeInstanceOf(SimulatedPrinter)
    expect(connector.simulated).toBe(true)
  })

  it('uses the simulator for a simulated row too', () => {
    expect(connectorFor(simulated, 'DEMO')).toBeInstanceOf(SimulatedPrinter)
  })

  it('keeps the device label, so the screen still names it', () => {
    expect(connectorFor(networked, 'DEMO').label).toBe('Goods-in printer')
  })
})

describe('in LIVE mode', () => {
  it('reaches the real printer', () => {
    const connector = connectorFor(networked, 'LIVE')

    expect(connector).toBeInstanceOf(TcpPrinter)
    expect(connector.simulated).toBe(false)
  })

  it('refuses a simulator rather than pretending to print', () => {
    // The failure this prevents: an operator asks for fifty RFID labels, sees
    // "Printed 50 (simulation)", and there are no labels and fifty EPCs
    // consumed against units that never got a tag.
    expect(() => connectorFor(simulated, 'LIVE')).toThrow(/no network address/i)
  })

  it('refuses a half-configured networked printer', () => {
    expect(() =>
      connectorFor({ ...networked, address: null }, 'LIVE'),
    ).toThrow(/no network address/i)
  })

  it('says what to do about it', () => {
    // An operator on the floor needs the next action, not a diagnosis.
    try {
      connectorFor(simulated, 'LIVE')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as Error).message).toMatch(/Add one under Devices|Demo mode/)
    }
  })
})

describe('the rule itself', () => {
  it('cannot be called without deciding the mode', () => {
    // `mode` is a required argument rather than something derived inside,
    // precisely so this cannot be forgotten. If it ever becomes optional, this
    // is the test that should stop it.
    expect(connectorFor.length).toBe(2)
  })
})
