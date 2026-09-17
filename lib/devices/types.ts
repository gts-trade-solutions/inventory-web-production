/**
 * The device abstraction, shared by both clients.
 *
 * Ported from the mobile app's Kotlin interfaces in `:core:devices` so the two
 * apps describe hardware the same way (ADR-006 / WADR-013). Neither client talks
 * to a specific scanner: they talk to these shapes, and the implementations —
 * keyboard wedge, WebHID, Zebra SDK, simulator — are interchangeable.
 *
 * No server-only imports: client components use these directly.
 */

export const DeviceKind = {
  SCANNER: 'SCANNER',
  RFID_READER: 'RFID_READER',
  PRINTER: 'PRINTER',
  MOBILE_COMPUTER: 'MOBILE_COMPUTER',
} as const
export type DeviceKind = (typeof DeviceKind)[keyof typeof DeviceKind]

export type ConnectionState =
  | { kind: 'DISCONNECTED' }
  | { kind: 'CONNECTING' }
  | { kind: 'CONNECTED'; info: DeviceInfo }
  | { kind: 'FAILED'; reason: string }

export interface DeviceInfo {
  model?: string
  firmware?: string
  batteryPercent?: number
  /** Drives the "Simulation" badge. Never hidden (DEMO_MODE.md §5). */
  simulated: boolean
}

/**
 * How a scan reached us.
 *
 * Tier 1 is the universal floor: any Zebra scanner paired as an HID keyboard,
 * in any browser, with nothing installed. Tier 2 adds symbology and device
 * identity but is Chromium-only, so it is never required
 * (DEVICE_INTEGRATION.md §1).
 */
export const ScanSource = {
  KEYBOARD_WEDGE: 'KEYBOARD_WEDGE',
  WEB_HID: 'WEB_HID',
  SIMULATED: 'SIMULATED',
  MANUAL: 'MANUAL',
} as const
export type ScanSource = (typeof ScanSource)[keyof typeof ScanSource]

export interface BarcodeScan {
  data: string
  /** Only Tier 2 and the simulators know this; keyboard wedge never does. */
  symbology: string | null
  source: ScanSource
  at: Date
}

export interface TagRead {
  epc: string
  rssi: number | null
  antenna: number | null
  at: Date
}
