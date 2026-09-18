import type { Metadata } from 'next'
import Link from 'next/link'
import { UserRole } from '@prisma/client'
import { requireRole } from '@/lib/auth/guards'
import { listTemplates } from '@/lib/services/label-templates'
import { PageHeader } from '@/components/page-header'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TemplateEditor, type EditableTemplate } from './template-editor'

export const metadata: Metadata = { title: 'Label templates' }

const BLANK: EditableTemplate = {
  name: '',
  kind: 'ITEM',
  // A working starting point rather than an empty box: somebody opening this
  // for the first time should be able to see a label before learning ZPL.
  zplBody: [
    '^XA^CI28^PW812^LL406',
    '^FO30,30^A0N,40,40^FB752,2,0,L^FD{{itemName}}^FS',
    '^FO30,125^A0N,28,28^FDSKU {{sku}}^FS',
    '^FO30,175^BY3,2,150^BEN,150,Y,N^FD{{barcode12}}^FS',
    '^XZ',
  ].join('\n'),
  widthMm: 102,
  heightMm: 51,
  dpi: 203,
  rfidEncode: false,
}

/**
 * Label templates, editable without a release (WADR-014).
 *
 * Administrator only. A label decides what a barcode encodes and whether a tag
 * is written, so this is closer to configuration than to content.
 */
export default async function LabelTemplatesPage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string }>
}) {
  const user = await requireRole(UserRole.ADMIN)
  const params = await searchParams

  const templates = await listTemplates(user.db)
  const editing = params.edit ? templates.find((row) => row.id === params.edit) : undefined

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Label templates"
        description="What prints, and what it encodes. Changing a template needs no release."
        actions={
          editing || params.edit === 'new' ? (
            <Button asChild variant="outline">
              <Link href="/admin/labels">Back to the list</Link>
            </Button>
          ) : (
            <Button asChild>
              <Link href="/admin/labels?edit=new">New template</Link>
            </Button>
          )
        }
      />

      {params.edit === 'new' || editing ? (
        <TemplateEditor
          template={
            editing
              ? {
                  id: editing.id,
                  name: editing.name,
                  kind: editing.kind,
                  zplBody: editing.zplBody,
                  widthMm: editing.widthMm,
                  heightMm: editing.heightMm,
                  dpi: editing.dpi,
                  rfidEncode: editing.rfidEncode,
                }
              : BLANK
          }
        />
      ) : (
        <div className="space-y-2">
          {templates.map((row) => (
            <div
              key={row.id}
              className={`flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4 ${
                row.active ? '' : 'opacity-60'
              }`}
            >
              <div className="min-w-48 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{row.name}</span>
                  <Badge variant="secondary">{row.kind.toLowerCase()}</Badge>
                  {row.rfidEncode && <Badge variant="outline">RFID</Badge>}
                  {!row.active && <Badge variant="secondary">Retired</Badge>}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {row.widthMm}×{row.heightMm}mm at {row.dpi} dpi
                  {row.needs.length > 0 && ` · needs ${row.needs.join(' and ')}`}
                  {row.usedBy > 0 && ` · used on ${row.usedBy} print job${row.usedBy === 1 ? '' : 's'}`}
                </p>
              </div>

              <Button asChild variant="outline" size="sm">
                <Link href={`/admin/labels?edit=${row.id}`}>Edit</Link>
              </Button>
            </div>
          ))}
        </div>
      )}

      <p className="text-sm text-muted-foreground">
        Templates are retired, never deleted: a print job records which one produced it, and that
        record is the only link between a physical RFID tag and the unit it belongs to.
      </p>
    </div>
  )
}
