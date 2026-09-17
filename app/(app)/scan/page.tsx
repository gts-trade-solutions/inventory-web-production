import type { Metadata } from 'next'
import { requireUser } from '@/lib/auth/guards'
import { ScanConsole } from './scan-console'
import { PageHeader } from '@/components/page-header'

export const metadata: Metadata = { title: 'Scan' }

/**
 * Scan-anywhere.
 *
 * The first piece of the Zebra device layer to ship, and deliberately the one
 * that needs no hardware on our side: any Zebra scanner paired as a Bluetooth
 * keyboard works with nothing installed (DEVICE_INTEGRATION.md §3).
 */
export default async function ScanPage() {
  const user = await requireUser()

  // A few real codes from this database, so the page is usable without a
  // scanner — one barcode, one RFID tag, one batch, one location. In Demo mode
  // this is how the whole flow is shown; in Live it is how someone checks the
  // page works before trusting it with a shift.
  const [barcode, tagged, batch, location] = await Promise.all([
    user.db.itemBarcode.findFirst({
      where: { isPrimary: true },
      select: { barcode: true },
      orderBy: { barcode: 'asc' },
    }),
    user.db.serialUnit.findFirst({
      where: { epc: { not: null } },
      select: { epc: true },
      orderBy: { serialNo: 'asc' },
    }),
    user.db.batch.findFirst({ select: { batchNo: true }, orderBy: { batchNo: 'asc' } }),
    user.db.location.findFirst({
      where: { deletedAt: null },
      select: { code: true },
      orderBy: { code: 'asc' },
    }),
  ])

  const samples = [barcode?.barcode, tagged?.epc, batch?.batchNo, location?.code].filter(
    (code): code is string => Boolean(code),
  )

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Scan"
        description="Point a scanner at anything. Item barcodes, case barcodes, RFID tags, serial numbers, batch labels and location labels all resolve here."
      />

      <ScanConsole demoBarcodes={samples} />
    </div>
  )
}
