import type { Metadata } from 'next'
import { UserRole } from '@prisma/client'
import { requireRole } from '@/lib/auth/guards'
import { PageHeader } from '@/components/page-header'
import { ImportForm } from './import-form'

export const metadata: Metadata = { title: 'Import' }

/**
 * Getting data in from a spreadsheet.
 *
 * Administrator only. Until this existed, loading a catalogue meant typing it
 * or asking a developer for SQL — the same dependency the admin phase set out
 * to remove.
 */
export default async function ImportPage() {
  await requireRole(UserRole.ADMIN)

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Import"
        description="Load items, locations and opening balances from a CSV file. Every import is checked before anything changes."
      />

      <ImportForm />
    </div>
  )
}
