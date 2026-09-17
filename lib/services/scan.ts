import 'server-only'
import type { PrismaClient } from '@prisma/client'
import { isEpc } from '@/lib/domain/sgtin96'
import { normaliseBarcode } from '@/lib/domain/gtin'
import { expiryStateOf, type ExpiryState } from './traceability'

/**
 * Resolving a scanned code to something the operator can act on.
 *
 * One entry point for every scanner, because an operator does not know or care
 * what they just pointed at: an item barcode, a case barcode, an RFID tag, a
 * location label and a batch label all come through the same beam.
 *
 * Order matters. An RFID tag is checked first because an EPC is unambiguous;
 * a bare numeric code could in principle be several things, so item barcodes —
 * overwhelmingly the common case — are checked before location codes.
 */

export type ScanResolution =
  | { kind: 'ITEM'; item: ScannedItem; packSize: number; barcodeType: string }
  | { kind: 'SERIAL'; unit: ScannedSerial; item: ScannedItem }
  | { kind: 'BATCH'; batch: ScannedBatch; item: ScannedItem }
  | { kind: 'LOCATION'; location: ScannedLocation }
  | { kind: 'UNKNOWN'; code: string; looksLikeEpc: boolean }

export interface ScannedItem {
  id: string
  sku: string
  name: string
  unit: string
  trackingMode: string
  onHand: number
  reorderPoint: number
}

export interface ScannedSerial {
  id: string
  serialNo: string
  status: string
  locationCode: string | null
  batchNo: string | null
}

export interface ScannedBatch {
  id: string
  batchNo: string
  expiryDate: Date | null
  expiryState: ExpiryState
  status: string
  onHand: number
}

export interface ScannedLocation {
  id: string
  code: string
  name: string
  zone: string
  distinctItems: number
}

export async function resolveScan(
  db: PrismaClient,
  raw: string,
  siteId: string,
  now: Date = new Date(),
): Promise<ScanResolution> {
  const code = raw.trim()
  if (!code) return { kind: 'UNKNOWN', code, looksLikeEpc: false }

  // --- An RFID tag resolves to exactly one physical unit ------------------
  if (isEpc(code)) {
    const unit = await db.serialUnit.findUnique({
      where: { epc: code.toUpperCase() },
      select: {
        id: true,
        serialNo: true,
        status: true,
        location: { select: { code: true } },
        batch: { select: { batchNo: true } },
        item: itemSelect,
      },
    })

    if (unit) {
      return {
        kind: 'SERIAL',
        unit: {
          id: unit.id,
          serialNo: unit.serialNo,
          status: unit.status,
          locationCode: unit.location?.code ?? null,
          batchNo: unit.batch?.batchNo ?? null,
        },
        item: toScannedItem(unit.item),
      }
    }

    // A valid EPC that matches nothing is a real finding, not a typo: a tag from
    // another site, or stock never received here. Saying so beats "not found".
    return { kind: 'UNKNOWN', code, looksLikeEpc: true }
  }

  // --- A printed serial number -------------------------------------------
  const bySerial = await db.serialUnit.findFirst({
    where: { serialNo: code },
    select: {
      id: true,
      serialNo: true,
      status: true,
      location: { select: { code: true } },
      batch: { select: { batchNo: true } },
      item: itemSelect,
    },
  })

  if (bySerial) {
    return {
      kind: 'SERIAL',
      unit: {
        id: bySerial.id,
        serialNo: bySerial.serialNo,
        status: bySerial.status,
        locationCode: bySerial.location?.code ?? null,
        batchNo: bySerial.batch?.batchNo ?? null,
      },
      item: toScannedItem(bySerial.item),
    }
  }

  // --- An item barcode ----------------------------------------------------
  // Normalised first: the same trade item arrives as a 12-digit UPC-A, a
  // 13-digit EAN-13 or a 14-digit GTIN-14 depending on the scanner and the
  // label, and comparing raw strings makes it hit on one and miss on another.
  const normalised = normaliseBarcode(code)

  const barcode = await db.itemBarcode.findFirst({
    where: { barcode: { in: [...new Set([code, normalised])] } },
    select: { barcode: true, type: true, packSize: true, item: itemSelect },
  })

  if (barcode) {
    return {
      kind: 'ITEM',
      item: toScannedItem(barcode.item),
      // A case barcode means a carton, so the movement form opens with the
      // pack quantity rather than 1.
      packSize: barcode.packSize,
      barcodeType: barcode.type,
    }
  }

  // --- A batch label ------------------------------------------------------
  const batch = await db.batch.findFirst({
    where: { batchNo: code },
    select: {
      id: true,
      batchNo: true,
      expiryDate: true,
      status: true,
      item: { ...itemSelect, select: { ...itemSelect.select, nearExpiryDays: true } },
    },
  })

  if (batch) {
    const onHand = await db.stockLevel.aggregate({
      where: { batchId: batch.id },
      _sum: { quantity: true },
    })
    const { state } = expiryStateOf(batch.expiryDate, now, batch.item.nearExpiryDays)

    return {
      kind: 'BATCH',
      batch: {
        id: batch.id,
        batchNo: batch.batchNo,
        expiryDate: batch.expiryDate,
        expiryState: state,
        status: batch.status,
        onHand: onHand._sum.quantity ?? 0,
      },
      item: toScannedItem(batch.item),
    }
  }

  // --- A location label ---------------------------------------------------
  const location = await db.location.findFirst({
    where: { siteId, code: { equals: code }, deletedAt: null },
    select: { id: true, code: true, name: true, zone: true },
  })

  if (location) {
    const distinct = await db.stockLevel.findMany({
      where: { locationId: location.id, quantity: { not: 0 } },
      select: { itemId: true },
      distinct: ['itemId'],
    })

    return {
      kind: 'LOCATION',
      location: { ...location, distinctItems: distinct.length },
    }
  }

  return { kind: 'UNKNOWN', code, looksLikeEpc: false }
}

const itemSelect = {
  select: {
    id: true,
    sku: true,
    name: true,
    unit: true,
    trackingMode: true,
    reorderPoint: true,
    stockLevels: { select: { quantity: true } },
  },
} as const

function toScannedItem(item: {
  id: string
  sku: string
  name: string
  unit: string
  trackingMode: string
  reorderPoint: number
  stockLevels: Array<{ quantity: number }>
}): ScannedItem {
  return {
    id: item.id,
    sku: item.sku,
    name: item.name,
    unit: item.unit,
    trackingMode: item.trackingMode,
    reorderPoint: item.reorderPoint,
    onHand: item.stockLevels.reduce((sum, level) => sum + level.quantity, 0),
  }
}
