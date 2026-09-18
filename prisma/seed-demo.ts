import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import {
  BatchStatus,
  DeviceConnection,
  DeviceKind,
  LabelKind,
  LocationZone,
  MovementSource,
  MovementType,
  PrismaClient,
  TrackingMode,
  UserRole,
} from '@prisma/client'
import bcrypt from 'bcryptjs'
import { DEMO_ACCOUNTS } from '../lib/demo-accounts'

/**
 * The demo dataset.
 *
 * Ported from the mobile app's `core/data/seed/SeedData.kt` — same 6 locations,
 * same product families, same valid EAN-13 barcodes — and extended for the
 * traceability model: batch-tracked items with staggered expiry (one near, one
 * expired, one quarantined) and serial-tracked items with real SGTIN-96 EPCs.
 *
 * Deterministic, so every demo starts from the same state and a rehearsed script
 * stays true.
 *
 * It does NOT fake a count variance. A variance is a difference between the
 * system and the shelf, and the shelf is not in the database — it appears when
 * an operator counts and types a different number. See the note near the end.
 *
 * Writes to the DEMO database only. Refuses to touch anything else.
 *
 *   npm run db:seed:demo
 */

const url = process.env.DATABASE_URL_DEMO
if (!url) throw new Error('DATABASE_URL_DEMO is not set. See .env.example.')
if (!/inventory_demo/.test(url)) {
  throw new Error(`Refusing to seed demo data into "${url}" — it is not the demo database.`)
}

const prisma = new PrismaClient({ datasourceUrl: url })

/** India's GS1 prefix (890) plus a demo company number, as the mobile app uses. */
const COMPANY_PREFIX = '8901234'

function checkDigit(first12: string): number {
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3)
  return (10 - (sum % 10)) % 10
}
const ean13 = (first12: string) => first12 + checkDigit(first12)

function sgtin96(gtin13: string, serial: number): string {
  const bits =
    (0x30).toString(2).padStart(8, '0') +
    (1).toString(2).padStart(3, '0') +
    (5).toString(2).padStart(3, '0') +
    Number(gtin13.slice(0, 7)).toString(2).padStart(24, '0') +
    Number(`0${gtin13.slice(7, 12)}`)
      .toString(2)
      .padStart(20, '0') +
    serial.toString(2).padStart(38, '0')

  let hex = ''
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  return hex.toUpperCase()
}

const LOCATIONS = [
  { code: 'RCV', name: 'Receiving dock', zone: LocationZone.INBOUND },
  { code: 'A-01', name: 'Aisle A · Rack 01', zone: LocationZone.STORAGE },
  { code: 'A-02', name: 'Aisle A · Rack 02', zone: LocationZone.STORAGE },
  { code: 'B-01', name: 'Aisle B · Rack 01', zone: LocationZone.STORAGE },
  { code: 'B-02', name: 'Aisle B · Rack 02', zone: LocationZone.STORAGE },
  { code: 'DSP', name: 'Dispatch bay', zone: LocationZone.OUTBOUND },
]

interface Product {
  sku: string
  name: string
  category: string
  unit: string
  reorderPoint: number
  tracking: TrackingMode
  expiryRequired?: boolean
  shelfLifeDays?: number
}

const PRODUCTS: Product[] = [
  // Consumables: untracked, exactly as the mobile MVP's items are today.
  {
    sku: 'PKG-0001',
    name: 'Corrugated box 30×20×15 cm',
    category: 'Packaging',
    unit: 'pcs',
    reorderPoint: 100,
    tracking: TrackingMode.NONE,
  },
  {
    sku: 'PKG-0002',
    name: 'Corrugated box 45×35×25 cm',
    category: 'Packaging',
    unit: 'pcs',
    reorderPoint: 80,
    tracking: TrackingMode.NONE,
  },
  {
    sku: 'PKG-0003',
    name: 'Stretch wrap roll 500 mm',
    category: 'Packaging',
    unit: 'rolls',
    reorderPoint: 20,
    tracking: TrackingMode.NONE,
  },
  {
    sku: 'PKG-0004',
    name: 'Packing tape 48 mm clear',
    category: 'Packaging',
    unit: 'rolls',
    reorderPoint: 40,
    tracking: TrackingMode.NONE,
  },
  {
    sku: 'PKG-0005',
    name: 'Bubble wrap roll 1 m × 50 m',
    category: 'Packaging',
    unit: 'rolls',
    reorderPoint: 10,
    tracking: TrackingMode.NONE,
  },
  {
    sku: 'PKG-0006',
    name: 'Pallet label pouch A5',
    category: 'Packaging',
    unit: 'pcs',
    reorderPoint: 200,
    tracking: TrackingMode.NONE,
  },
  {
    sku: 'SAF-0007',
    name: 'Safety helmet, white',
    category: 'Safety',
    unit: 'pcs',
    reorderPoint: 20,
    tracking: TrackingMode.NONE,
  },
  {
    sku: 'SAF-0008',
    name: 'Hi-vis vest, size L',
    category: 'Safety',
    unit: 'pcs',
    reorderPoint: 25,
    tracking: TrackingMode.NONE,
  },
  {
    sku: 'SAF-0009',
    name: 'Nitrile gloves, size M (box of 100)',
    category: 'Safety',
    unit: 'boxes',
    reorderPoint: 30,
    tracking: TrackingMode.NONE,
  },
  {
    sku: 'SAF-0010',
    name: 'Safety goggles, anti-fog',
    category: 'Safety',
    unit: 'pcs',
    reorderPoint: 20,
    tracking: TrackingMode.NONE,
  },
  {
    sku: 'SAF-0011',
    name: 'Ear plugs (box of 200)',
    category: 'Safety',
    unit: 'boxes',
    reorderPoint: 10,
    tracking: TrackingMode.NONE,
  },
  {
    sku: 'SAF-0012',
    name: 'Safety shoes, size 42',
    category: 'Safety',
    unit: 'pairs',
    reorderPoint: 8,
    tracking: TrackingMode.NONE,
  },
  {
    sku: 'CON-0013',
    name: 'Cleaning cloth, blue (pack of 50)',
    category: 'Consumables',
    unit: 'packs',
    reorderPoint: 15,
    tracking: TrackingMode.NONE,
  },
  {
    sku: 'CON-0014',
    name: 'Cable tie 300 mm (bag of 100)',
    category: 'Consumables',
    unit: 'bags',
    reorderPoint: 25,
    tracking: TrackingMode.NONE,
  },
  {
    sku: 'CON-0015',
    name: 'Marker pen, black',
    category: 'Consumables',
    unit: 'pcs',
    reorderPoint: 30,
    tracking: TrackingMode.NONE,
  },

  // Batch-tracked, with shelf lives. These drive the expiry board and FEFO.
  {
    sku: 'CHM-0016',
    name: 'Industrial adhesive 5 L',
    category: 'Chemicals',
    unit: 'cans',
    reorderPoint: 6,
    tracking: TrackingMode.BATCH,
    expiryRequired: true,
    shelfLifeDays: 365,
  },
  {
    sku: 'CHM-0017',
    name: 'Solvent cleaner 2 L',
    category: 'Chemicals',
    unit: 'bottles',
    reorderPoint: 10,
    tracking: TrackingMode.BATCH,
    expiryRequired: true,
    shelfLifeDays: 540,
  },
  {
    sku: 'CHM-0018',
    name: 'Epoxy resin kit 1 kg',
    category: 'Chemicals',
    unit: 'kits',
    reorderPoint: 4,
    tracking: TrackingMode.BATCH,
    expiryRequired: true,
    shelfLifeDays: 270,
  },
  {
    sku: 'CHM-0019',
    name: 'Lubricating grease 500 g',
    category: 'Chemicals',
    unit: 'tubs',
    reorderPoint: 8,
    tracking: TrackingMode.BATCH,
    expiryRequired: true,
    shelfLifeDays: 730,
  },
  {
    sku: 'CHM-0020',
    name: 'Threadlocker 50 ml',
    category: 'Chemicals',
    unit: 'bottles',
    reorderPoint: 12,
    tracking: TrackingMode.BATCH,
    expiryRequired: true,
    shelfLifeDays: 365,
  },

  // Serial-tracked. Each unit carries a real SGTIN-96 EPC.
  {
    sku: 'TLS-0021',
    name: 'Cordless drill 18 V',
    category: 'Tools',
    unit: 'pcs',
    reorderPoint: 3,
    tracking: TrackingMode.SERIAL,
  },
  {
    sku: 'TLS-0022',
    name: 'Torque wrench 20–200 Nm',
    category: 'Tools',
    unit: 'pcs',
    reorderPoint: 2,
    tracking: TrackingMode.SERIAL,
  },
  {
    sku: 'TLS-0023',
    name: 'Laser distance meter',
    category: 'Tools',
    unit: 'pcs',
    reorderPoint: 2,
    tracking: TrackingMode.SERIAL,
  },
  {
    sku: 'TLS-0024',
    name: 'Heat gun 2000 W',
    category: 'Tools',
    unit: 'pcs',
    reorderPoint: 2,
    tracking: TrackingMode.SERIAL,
  },
  {
    sku: 'TLS-0025',
    name: 'Digital multimeter',
    category: 'Tools',
    unit: 'pcs',
    reorderPoint: 3,
    tracking: TrackingMode.SERIAL,
  },
]

const REASON_CODES = [
  {
    code: 'COUNT_VAR',
    label: 'Cycle count variance',
    appliesTo: 'ADJUST' as const,
    requiresNote: false,
  },
  {
    code: 'DAMAGE',
    label: 'Damaged in handling',
    appliesTo: 'ADJUST' as const,
    requiresNote: true,
  },
  {
    code: 'FOUND',
    label: 'Found unrecorded stock',
    appliesTo: 'ADJUST' as const,
    requiresNote: true,
  },
  { code: 'DATA_FIX', label: 'Data correction', appliesTo: 'ADJUST' as const, requiresNote: true },
  { code: 'EXPIRED', label: 'Past expiry date', appliesTo: 'SCRAP' as const, requiresNote: false },
  { code: 'BROKEN', label: 'Broken or unusable', appliesTo: 'SCRAP' as const, requiresNote: true },
  {
    code: 'QUALITY',
    label: 'Failed quality check',
    appliesTo: 'QUARANTINE' as const,
    requiresNote: true,
  },
  {
    code: 'RECALL',
    label: 'Supplier recall',
    appliesTo: 'QUARANTINE' as const,
    requiresNote: true,
  },
]

const DAY = 86_400_000

async function main() {
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)

  console.log('Resetting the demo database …')
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 0')
  for (const table of [
    'movement_serials',
    'count_tags',
    'count_lines',
    'count_sessions',
    'print_jobs',
    'movements',
    'stock_levels',
    'serial_units',
    'batches',
    'epc_serial_blocks',
    'item_barcodes',
    'items',
    'categories',
    'locations',
    'number_sequences',
    'audit_log',
    'refresh_tokens',
    'user_sites',
    'users',
    'devices',
    'label_templates',
    'reason_codes',
    'settings',
    'sites',
  ]) {
    await prisma.$executeRawUnsafe(`DELETE FROM ${table}`)
  }
  await prisma.$executeRawUnsafe('SET FOREIGN_KEY_CHECKS = 1')

  const site = await prisma.site.create({
    data: { id: randomUUID(), code: 'WH1', name: 'Main warehouse' },
  })

  for (const reason of REASON_CODES) {
    await prisma.reasonCode.create({ data: { id: randomUUID(), ...reason } })
  }

  for (const setting of [
    { key: 'expiry.issuePolicy', value: 'BLOCK' },
    { key: 'allocation.fefo', value: true },
    { key: 'adjust.userLimit', value: 100 },
    { key: 'count.autoApproveThreshold', value: null },
  ]) {
    await prisma.setting.create({
      data: { key: setting.key, siteId: '', value: setting.value as never },
    })
  }

  for (const demoUser of DEMO_ACCOUNTS) {
    const user = await prisma.user.create({
      data: {
        id: randomUUID(),
        email: demoUser.email,
        name: demoUser.name,
        passwordHash: await bcrypt.hash(demoUser.password, 12),
        role: demoUser.role,
        defaultSiteId: site.id,
      },
    })
    await prisma.userSite.create({ data: { userId: user.id, siteId: site.id } })
  }
  const operator = await prisma.user.findFirstOrThrow({ where: { role: UserRole.USER } })

  const locations = new Map<string, string>()
  for (const location of LOCATIONS) {
    const created = await prisma.location.create({
      data: { id: randomUUID(), siteId: site.id, ...location },
    })
    locations.set(location.code, created.id)
  }

  const categories = new Map<string, string>()
  for (const name of [...new Set(PRODUCTS.map((p) => p.category))]) {
    const created = await prisma.category.create({ data: { id: randomUUID(), name } })
    categories.set(name, created.id)
  }

  const storage = ['A-01', 'A-02', 'B-01', 'B-02']
  let sequence = 0
  let movements = 0
  let batchCount = 0
  let serialCount = 0

  const ledger: Array<{
    itemId: string
    type: MovementType
    quantity: number
    batchId: string | null
    from: string | null
    to: string | null
    serials: string[]
    daysAgo: number
  }> = []

  for (const [index, product] of PRODUCTS.entries()) {
    const gtin = ean13(COMPANY_PREFIX + String(index + 1).padStart(5, '0'))

    const item = await prisma.item.create({
      data: {
        id: randomUUID(),
        sku: product.sku,
        name: product.name,
        categoryId: categories.get(product.category)!,
        unit: product.unit,
        reorderPoint: product.reorderPoint,
        trackingMode: product.tracking,
        expiryRequired: product.expiryRequired ?? false,
        shelfLifeDays: product.shelfLifeDays ?? null,
      },
    })

    await prisma.itemBarcode.create({
      data: {
        id: randomUUID(),
        itemId: item.id,
        barcode: gtin,
        type: 'EAN13',
        packSize: 1,
        isPrimary: true,
      },
    })
    // A case barcode, so scanning a carton means a dozen units rather than one.
    await prisma.itemBarcode.create({
      data: {
        id: randomUUID(),
        itemId: item.id,
        barcode: `1${gtin.slice(0, 12)}${checkDigit(gtin.slice(0, 12))}`,
        type: 'ITF14',
        packSize: 12,
      },
    })

    const home = storage[index % storage.length]!
    const homeId = locations.get(home)!

    if (product.tracking === TrackingMode.BATCH) {
      // Staggered expiry: healthy, near-expiry, expired, and one quarantined.
      const plans = [
        { suffix: 'A', days: 240, status: BatchStatus.ACTIVE, qty: 18 },
        { suffix: 'B', days: 21, status: BatchStatus.ACTIVE, qty: 9 },
        { suffix: 'C', days: -6, status: BatchStatus.ACTIVE, qty: 5 },
        ...(index % 5 === 0
          ? [{ suffix: 'Q', days: 300, status: BatchStatus.QUARANTINE, qty: 4 }]
          : []),
      ]

      for (const plan of plans) {
        const batch = await prisma.batch.create({
          data: {
            id: randomUUID(),
            itemId: item.id,
            batchNo: `LOT-${product.sku.slice(-4)}-${plan.suffix}`,
            mfgDate: new Date(today.getTime() - 120 * DAY),
            expiryDate: new Date(today.getTime() + plan.days * DAY),
            supplierRef: `SUP-${1000 + index}`,
            status: plan.status,
          },
        })
        batchCount++
        ledger.push({
          itemId: item.id,
          type: MovementType.RECEIVE,
          quantity: plan.qty,
          batchId: batch.id,
          from: null,
          to: homeId,
          serials: [],
          daysAgo: 30,
        })
      }
    } else if (product.tracking === TrackingMode.SERIAL) {
      const units: string[] = []
      for (let n = 0; n < 4; n++) {
        const serial = 100_000 + index * 100 + n
        const unit = await prisma.serialUnit.create({
          data: {
            id: randomUUID(),
            itemId: item.id,
            serialNo: `${product.sku}-${String(n + 1).padStart(4, '0')}`,
            epc: sgtin96(gtin, serial),
            locationId: homeId,
          },
        })
        units.push(unit.id)
        serialCount++
      }
      ledger.push({
        itemId: item.id,
        type: MovementType.RECEIVE,
        quantity: units.length,
        batchId: null,
        from: null,
        to: homeId,
        serials: units,
        daysAgo: 30,
      })
    } else {
      // Opening balance, with a few items deliberately below reorder point so
      // the low-stock list is not empty.
      const opening =
        index % 7 === 0
          ? Math.max(1, Math.floor(product.reorderPoint * 0.4))
          : product.reorderPoint * 3 + ((index * 13) % 40)

      ledger.push({
        itemId: item.id,
        type: MovementType.RECEIVE,
        quantity: opening,
        batchId: null,
        from: null,
        to: homeId,
        serials: [],
        daysAgo: 30,
      })

      // A little recent history: issues and a transfer.
      if (index % 3 === 0) {
        ledger.push({
          itemId: item.id,
          type: MovementType.ISSUE,
          quantity: Math.max(1, Math.floor(opening * 0.1)),
          batchId: null,
          from: homeId,
          to: null,
          serials: [],
          daysAgo: 3,
        })
      }
      if (index % 4 === 0) {
        ledger.push({
          itemId: item.id,
          type: MovementType.MOVE,
          quantity: Math.max(1, Math.floor(opening * 0.15)),
          batchId: null,
          from: homeId,
          to: locations.get('DSP')!,
          serials: [],
          daysAgo: 1,
        })
      }
    }
  }

  // Write the ledger and its projection together, oldest first.
  ledger.sort((a, b) => b.daysAgo - a.daysAgo)

  for (const entry of ledger) {
    const prefix = {
      RECEIVE: 'RCV',
      ISSUE: 'ISS',
      MOVE: 'MOV',
      ADJUST: 'ADJ',
      COUNT: 'CNT',
      SCRAP: 'SCR',
    }[entry.type]
    const movementId = randomUUID()
    const at = new Date(today.getTime() - entry.daysAgo * DAY + (sequence % 8) * 3_600_000)

    await prisma.movement.create({
      data: {
        id: movementId,
        docNo: `${prefix}-${today.getUTCFullYear()}-${String(++sequence).padStart(6, '0')}`,
        siteId: site.id,
        itemId: entry.itemId,
        type: entry.type,
        quantity: entry.quantity,
        batchId: entry.batchId,
        fromLocationId: entry.from,
        toLocationId: entry.to,
        occurredAt: at,
        recordedAt: at,
        userId: operator.id,
        source: MovementSource.WEB,
        note: entry.type === MovementType.RECEIVE ? 'Opening balance' : null,
      },
    })
    movements++

    if (entry.serials.length > 0) {
      await prisma.movementSerial.createMany({
        data: entry.serials.map((serialUnitId) => ({ movementId, serialUnitId })),
      })
    }

    const batchKey = entry.batchId ?? '00000000-0000-0000-0000-000000000000'
    for (const [locationId, delta] of [
      [entry.to, entry.quantity],
      [entry.from, -entry.quantity],
    ] as const) {
      if (!locationId) continue
      await prisma.$executeRaw`
        INSERT INTO stock_levels (itemId, locationId, batchId, quantity, updatedAt)
        VALUES (${entry.itemId}, ${locationId}, ${batchKey}, ${delta}, NOW(3))
        ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity), updatedAt = NOW(3)
      `
    }
  }

  await prisma.$executeRawUnsafe('DELETE FROM stock_levels WHERE quantity = 0')

  // Numbering must continue from what the seed used, or the first real movement
  // collides on docNo.
  for (const key of ['RECEIVE', 'ISSUE', 'MOVE', 'ADJUST', 'SCRAP', 'COUNT', 'PRINT']) {
    const prefix = {
      RECEIVE: 'RCV',
      ISSUE: 'ISS',
      MOVE: 'MOV',
      ADJUST: 'ADJ',
      SCRAP: 'SCR',
      COUNT: 'CNT',
      PRINT: 'PRN',
    }[key]!
    await prisma.numberSequence.create({
      data: {
        key,
        period: String(today.getUTCFullYear()),
        prefix,
        nextValue: sequence + 1,
        padding: 6,
      },
    })
  }

  // --- Label templates and devices --------------------------------------
  //
  // Templates live in the database, not in code, so a label can be changed
  // without an app release (WADR-014). These are the formats the mobile MVP
  // hard-codes in Kotlin, moved to rows.
  //
  // The devices are all simulated, and the UI says so on every screen they
  // appear on. That is what lets the whole print and scan story be demonstrated
  // before any Zebra hardware exists — and what makes it obvious that it is a
  // demonstration (DEVICE_INTEGRATION §8).

  const itemLabel = [
    '^XA^CI28^PW812^LL406',
    '^FO30,30^A0N,40,40^FB752,2,0,L^FD{{itemName}}^FS',
    // Only fields an item alone can supply. A placeholder the operator has no
    // way to fill turns the print screen into a refusal they cannot act on.
    '^FO30,125^A0N,28,28^FDSKU {{sku}}^FS',
    // ^BE is EAN-13: the printer takes 12 digits and adds the check digit.
    '^FO30,175^BY3,2,150^BEN,150,Y,N^FD{{barcode12}}^FS',
    '^XZ',
  ].join('\n')

  await prisma.labelTemplate.createMany({
    data: [
      {
        id: randomUUID(),
        name: 'Item label 4x2',
        kind: LabelKind.ITEM,
        zplBody: itemLabel,
        widthMm: 102,
        heightMm: 51,
        dpi: 203,
        rfidEncode: false,
      },
      {
        id: randomUUID(),
        name: 'Item label 4x2 with RFID',
        kind: LabelKind.ITEM,
        zplBody: itemLabel,
        widthMm: 102,
        heightMm: 51,
        dpi: 203,
        rfidEncode: true,
      },
      {
        id: randomUUID(),
        name: 'Batch label 4x2',
        kind: LabelKind.BATCH,
        zplBody: [
          '^XA^CI28^PW812^LL406',
          '^FO30,30^A0N,40,40^FB752,2,0,L^FD{{itemName}}^FS',
          '^FO30,125^A0N,32,32^FDBATCH {{batchNo}}^FS',
          '^FO30,175^A0N,32,32^FDEXPIRES {{expiryDate}}^FS',
          '^FO30,230^BY3,2,120^BCN,120,Y,N,N^FD{{batchNo}}^FS',
          '^XZ',
        ].join('\n'),
        widthMm: 102,
        heightMm: 51,
        dpi: 203,
        rfidEncode: false,
      },
      {
        id: randomUUID(),
        name: 'Location label 2x1',
        kind: LabelKind.LOCATION,
        zplBody: [
          '^XA^CI28^PW406^LL203',
          '^FO20,15^A0N,60,60^FD{{code}}^FS',
          '^FO20,85^BY2,2,80^BCN,80,Y,N,N^FD{{code}}^FS',
          '^XZ',
        ].join('\n'),
        widthMm: 51,
        heightMm: 25,
        dpi: 203,
        rfidEncode: false,
      },
    ],
  })

  await prisma.device.createMany({
    data: [
      {
        id: randomUUID(),
        label: 'Goods-in printer (simulated)',
        kind: DeviceKind.PRINTER,
        vendor: 'Zebra',
        model: 'ZD621R',
        connection: DeviceConnection.SIMULATED,
        siteId: site.id,
        lastSeenAt: new Date(),
      },
      {
        id: randomUUID(),
        label: 'Aisle A reader (simulated)',
        kind: DeviceKind.RFID_READER,
        vendor: 'Zebra',
        model: 'FX9600',
        connection: DeviceConnection.SIMULATED,
        siteId: site.id,
        lastSeenAt: new Date(),
      },
      {
        id: randomUUID(),
        label: 'Ring scanner (simulated)',
        kind: DeviceKind.SCANNER,
        vendor: 'Zebra',
        model: 'RS5100',
        connection: DeviceConnection.SIMULATED,
        siteId: site.id,
        lastSeenAt: new Date(),
      },
    ],
  })

  // --- On planting variances -------------------------------------------
  // An earlier version added 2 units directly to stock_levels here, to make a
  // cycle count find something. That was wrong: it created rows the ledger does
  // not explain, which is precisely the corruption findProjectionDrift() exists
  // to detect — and it duly reported the demo database as broken.
  //
  // A real variance is a difference between the system and the SHELF, and the
  // shelf is not in the database. It appears when an operator counts and enters
  // a different number, or when the RFID simulator reports fewer tags than
  // expected (Phase 6). Nothing here should fake it.

  console.log(`
Demo database seeded.

  items           ${PRODUCTS.length}
  locations       ${LOCATIONS.length}
  batches         ${batchCount}
  serial units    ${serialCount}
  movements       ${movements}
  label templates 4
  devices         3 (all simulated, and labelled as such)

Sign in at /login with Demo selected:
  admin@inventory.local      / demo1234   (Administrator)
  supervisor@inventory.local / demo1234   (Supervisor)
  operator@inventory.local   / demo1234   (User)
`)
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
