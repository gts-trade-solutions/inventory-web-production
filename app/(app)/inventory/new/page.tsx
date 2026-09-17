import type { Metadata } from 'next'
import Link from 'next/link'
import { UserRole } from '@prisma/client'
import { ArrowLeft } from 'lucide-react'
import { requireRole } from '@/lib/auth/guards'
import { ItemForm } from '../item-form'
import { PageHeader } from '@/components/page-header'

export const metadata: Metadata = { title: 'New item' }

export default async function NewItemPage() {
  const user = await requireRole(UserRole.ADMIN)

  const categories = await user.db.category.findMany({
    where: { active: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  })

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link
        href="/inventory"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Inventory
      </Link>

      <PageHeader
        title="New item"
        description="Tracking is the decision that matters — it is fixed once stock moves."
      />

      <ItemForm
        categories={categories}
        trackingLocked={false}
        initial={{
          sku: '',
          name: '',
          unit: 'pcs',
          categoryId: null,
          reorderPoint: 0,
          maxLevel: null,
          trackingMode: 'NONE',
          expiryRequired: false,
          shelfLifeDays: null,
          nearExpiryDays: 30,
          active: true,
          barcodes: [],
        }}
      />
    </div>
  )
}
