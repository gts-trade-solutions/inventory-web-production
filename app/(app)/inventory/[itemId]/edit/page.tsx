import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { UserRole } from '@prisma/client'
import { ArrowLeft } from 'lucide-react'
import { requireRole } from '@/lib/auth/guards'
import { ItemForm, type ItemFormValues } from '../../item-form'
import { PageHeader } from '@/components/page-header'

export const metadata: Metadata = { title: 'Edit item' }

export default async function EditItemPage({ params }: { params: Promise<{ itemId: string }> }) {
  const user = await requireRole(UserRole.ADMIN)
  const { itemId } = await params

  const [item, categories, movements] = await Promise.all([
    user.db.item.findFirst({
      where: { id: itemId, deletedAt: null },
      include: { barcodes: { orderBy: [{ isPrimary: 'desc' }, { barcode: 'asc' }] } },
    }),
    user.db.category.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    user.db.movement.count({ where: { itemId } }),
  ])

  if (!item) notFound()

  const initial: ItemFormValues = {
    id: item.id,
    sku: item.sku,
    name: item.name,
    unit: item.unit,
    categoryId: item.categoryId,
    reorderPoint: item.reorderPoint,
    maxLevel: item.maxLevel,
    trackingMode: item.trackingMode,
    expiryRequired: item.expiryRequired,
    shelfLifeDays: item.shelfLifeDays,
    nearExpiryDays: item.nearExpiryDays,
    active: item.active,
    barcodes: item.barcodes.map((barcode) => ({
      barcode: barcode.barcode,
      type: barcode.type,
      packSize: barcode.packSize,
      isPrimary: barcode.isPrimary,
    })),
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link
        href={`/inventory/${item.id}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        {item.name}
      </Link>

      <PageHeader title="Edit item" description={item.sku} />

      <ItemForm initial={initial} categories={categories} trackingLocked={movements > 0} />
    </div>
  )
}
