'use client'

import { useActionState, useMemo, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
import { saveTemplateAction, type TemplateState } from './actions'
import { LabelPreviewer } from '../../labels/label-preview'
import { LABEL_FIELDS, requirementsOf, sampleFields } from '@/lib/labels/fields'
import { placeholdersIn, renderTemplate, validateZpl, ZplError } from '@/lib/labels/zpl'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** Mirrors the Prisma enum; a client component may not import its values. */
type Kind = 'ITEM' | 'BATCH' | 'SERIAL' | 'LOCATION' | 'PALLET'

export interface EditableTemplate {
  id?: string
  name: string
  kind: Kind
  zplBody: string
  widthMm: number
  heightMm: number
  dpi: number
  rfidEncode: boolean
}

/**
 * Editing a label, with the preview drawn from what was typed.
 *
 * The preview substitutes sample values and renders through exactly the same
 * code the printer's bytes go through, so what is on screen is the template —
 * not a drawing of what it is hoped to mean.
 *
 * Complaints are computed live from the same rules the server enforces. They
 * are shown while typing and enforced again on save, because a client-side
 * check is a courtesy and the server is the decision.
 */
export function TemplateEditor({ template }: { template: EditableTemplate }) {
  const [state, formAction] = useActionState<TemplateState, FormData>(saveTemplateAction, {})
  const [zpl, setZpl] = useState(template.zplBody)
  const [rfid, setRfid] = useState(template.rfidEncode)

  const review = useMemo(() => {
    const problems: string[] = []

    try {
      validateZpl(zpl)
    } catch (error) {
      problems.push(error instanceof ZplError ? error.message : 'That ZPL could not be read.')
    }

    const placeholders = placeholdersIn(zpl)
    const { needs, unknown } = requirementsOf(placeholders)

    if (unknown.length > 0) {
      problems.push(
        `Nothing can fill ${unknown.map((name) => `{{${name}}}`).join(', ')}.`,
      )
    }
    if (/\^RFW/i.test(zpl)) {
      problems.push('Remove ^RFW — tag data is added per label when printing.')
    }
    if (rfid && /\^PQ/i.test(zpl)) {
      problems.push('An RFID template cannot use ^PQ.')
    }

    let preview = ''
    if (problems.length === 0) {
      try {
        preview = renderTemplate(zpl, sampleFields())
      } catch {
        preview = ''
      }
    }

    return { problems, needs, preview }
  }, [zpl, rfid])

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <form action={formAction} className="space-y-4">
        {template.id && <input type="hidden" name="templateId" value={template.id} />}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" defaultValue={template.name} required />
          </div>

          <div className="space-y-2">
            <Label htmlFor="kind">Kind</Label>
            <select
              id="kind"
              name="kind"
              defaultValue={template.kind}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="ITEM">Item</option>
              <option value="BATCH">Batch</option>
              <option value="SERIAL">Serial unit</option>
              <option value="LOCATION">Location</option>
              <option value="PALLET">Pallet</option>
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="widthMm">Width (mm)</Label>
            <Input id="widthMm" name="widthMm" type="number" defaultValue={template.widthMm} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="heightMm">Height (mm)</Label>
            <Input id="heightMm" name="heightMm" type="number" defaultValue={template.heightMm} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="dpi">Printer resolution</Label>
            <select
              id="dpi"
              name="dpi"
              defaultValue={template.dpi}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value={203}>203 dpi</option>
              <option value={300}>300 dpi</option>
              <option value={600}>600 dpi</option>
            </select>
            {/* The same template on the wrong printer prints off the edge. */}
            <p className="text-xs text-muted-foreground">
              A 4-inch label is 812 dots at 203 dpi and 1200 at 300.
            </p>
          </div>

          <div className="flex items-end gap-2">
            <input
              id="rfidEncode"
              name="rfidEncode"
              type="checkbox"
              checked={rfid}
              onChange={(event) => setRfid(event.target.checked)}
              className="size-4"
            />
            <Label htmlFor="rfidEncode">Encodes an RFID tag</Label>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="zplBody">ZPL</Label>
          <textarea
            id="zplBody"
            name="zplBody"
            value={zpl}
            onChange={(event) => setZpl(event.target.value)}
            spellCheck={false}
            rows={14}
            className="tabular w-full rounded-md border border-input bg-background p-3 text-xs"
          />
        </div>

        {review.problems.length > 0 && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-4">
                {review.problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {state.error && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}

        {state.message && (
          <Alert>
            <CheckCircle2 className="size-4 text-ok" />
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}

        <SaveButton disabled={review.problems.length > 0} />
      </form>

      <div className="space-y-4">
        <div>
          <h2 className="font-medium">Preview</h2>
          <p className="text-sm text-muted-foreground">
            Drawn from the same bytes a printer receives, with sample values in place of real ones.
          </p>
        </div>

        {review.preview ? (
          <LabelPreviewer zpl={review.preview} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Fix the problems above to see the label.
          </p>
        )}

        <div className="rounded-lg border p-3">
          <p className="text-sm font-medium">
            This label needs{' '}
            {review.needs.length === 0 ? 'nothing chosen before printing' : review.needs.join(' and ')}
          </p>

          <p className="mt-3 text-xs text-muted-foreground">
            Available fields — click to copy the placeholder into your clipboard.
          </p>
          <div className="mt-2 flex flex-wrap gap-1">
            {LABEL_FIELDS.map((field) => (
              <button
                key={field.name}
                type="button"
                title={`${field.describes} · e.g. ${field.sample}`}
                onClick={() => void navigator.clipboard?.writeText(`{{${field.name}}}`)}
                className="cursor-pointer"
              >
                <Badge variant="outline" className="tabular font-normal">
                  {`{{${field.name}}}`}
                </Badge>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function SaveButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" disabled={pending || disabled}>
      {pending ? (
        <>
          <Loader2 className="mr-2 size-4 animate-spin" />
          Saving…
        </>
      ) : (
        'Save template'
      )}
    </Button>
  )
}
