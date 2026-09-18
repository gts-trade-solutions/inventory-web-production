'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { Loader2, Save } from 'lucide-react'
import { updateSequenceAction, type MasterDataState } from './actions'
import { Notice } from './notice'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

export interface SequenceRow {
  key: string
  purpose: string
  period: string
  prefix: string
  nextValue: number
  padding: number
  preview: string
  exists: boolean
}

export function SequencesAdmin({
  sequences,
  period,
}: {
  sequences: SequenceRow[]
  period: string
}) {
  const [state, save] = useActionState<MasterDataState, FormData>(updateSequenceAction, {})

  return (
    <section className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Document numbering · {period}</CardTitle>
          <CardDescription>
            The numbers people quote when they refer to paperwork. Numbering restarts each year, and
            a number is allocated when the document is recorded — so a movement queued offline on a
            phone is numbered when it syncs, not when it was typed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <strong className="font-medium text-foreground">
              The next number can be raised but not lowered.
            </strong>{' '}
            Raising it skips numbers, which leaves a visible gap. Lowering it would give a second
            document a name that is already on paperwork somebody has filed — which only surfaces
            much later, when two deliveries turn out to share a reference.
          </p>
        </CardContent>
      </Card>

      <Notice state={state} />

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Documents</TableHead>
              <TableHead className="w-24">Prefix</TableHead>
              <TableHead className="w-32">Next number</TableHead>
              <TableHead className="w-24">Digits</TableHead>
              <TableHead className="w-48">Next will be</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sequences.map((sequence) => (
              <TableRow key={sequence.key}>
                <TableCell>
                  <div className="font-medium">{sequence.purpose}</div>
                  {!sequence.exists && (
                    <div className="text-xs text-muted-foreground">None issued yet this year</div>
                  )}
                </TableCell>

                {/* One form per row. A single form around the table would post
                    every sequence on every save, so a stale field in a row
                    nobody touched would overwrite a change made elsewhere. */}
                <TableCell colSpan={5} className="p-0">
                  <form action={save} className="flex items-center gap-2 px-4 py-2">
                    <input type="hidden" name="key" value={sequence.key} />
                    <input type="hidden" name="period" value={sequence.period} />

                    <Input
                      name="prefix"
                      defaultValue={sequence.prefix}
                      className="tabular w-20 uppercase"
                      maxLength={3}
                      aria-label={`Prefix for ${sequence.purpose}`}
                    />
                    <Input
                      name="nextValue"
                      type="number"
                      min={sequence.nextValue}
                      defaultValue={sequence.nextValue}
                      className="tabular w-28"
                      aria-label={`Next number for ${sequence.purpose}`}
                    />
                    <Input
                      name="padding"
                      type="number"
                      min={1}
                      max={12}
                      defaultValue={sequence.padding}
                      className="tabular w-20"
                      aria-label={`Digits for ${sequence.purpose}`}
                    />

                    <span className="tabular flex-1 text-sm text-muted-foreground">
                      {sequence.preview}
                    </span>

                    <SaveButton />
                  </form>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}

function SaveButton() {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" size="sm" variant="outline" disabled={pending}>
      {pending ? <Loader2 className="animate-spin" /> : <Save />}
      Save
    </Button>
  )
}
