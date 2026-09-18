'use client'

import { useActionState, useRef, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, CheckCircle2, FileUp, Loader2, Upload } from 'lucide-react'
import { importAction, type ImportState } from './actions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'

type Kind = 'items' | 'locations' | 'balances'

const COLUMNS: Record<Kind, { required: string; optional: string; example: string }> = {
  items: {
    required: 'sku, name',
    optional: 'unit, reorderPoint, tracking (NONE/BATCH/SERIAL), barcode',
    example: 'sku,name,unit,reorderPoint,tracking,barcode\nPKG-0001,Corrugated box,pcs,100,NONE,8901234000014',
  },
  locations: {
    required: 'code, name',
    optional: 'zone (INBOUND/STORAGE/OUTBOUND)',
    example: 'code,name,zone\nA-03,Aisle A · Rack 03,STORAGE',
  },
  balances: {
    required: 'sku, location, quantity',
    optional: 'batch (required for batch-tracked items)',
    example: 'sku,location,quantity,batch\nPKG-0001,A-01,240,\nCHM-0016,A-01,18,LOT-0016-A',
  },
}

/**
 * Import, with the dry run in front of the commit.
 *
 * The preview is not a convenience. An import is the one operation that can be
 * wrong five hundred times before anybody notices, so the decision to commit is
 * made with the errors already on screen.
 */
export function ImportForm() {
  const [state, formAction] = useActionState<ImportState, FormData>(importAction, {})
  const [kind, setKind] = useState<Kind>('items')
  const [text, setText] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const guide = COLUMNS[kind]
  const plan = state.plan
  const usable = plan ? plan.create + plan.update : 0

  return (
    <div className="space-y-6">
      <form action={formAction} className="space-y-4">
        <input type="hidden" name="text" value={text} />

        <div className="space-y-2">
          <Label htmlFor="kind">What is in the file</Label>
          <select
            id="kind"
            name="kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as Kind)}
            className="h-11 w-full max-w-sm rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="items">Items</option>
            <option value="locations">Locations</option>
            <option value="balances">Opening balances</option>
          </select>
        </div>

        <div className="rounded-lg border bg-muted/30 p-3 text-sm">
          <p>
            <span className="font-medium">Required columns:</span>{' '}
            <span className="tabular">{guide.required}</span>
          </p>
          <p className="mt-1">
            <span className="font-medium">Optional:</span>{' '}
            <span className="tabular">{guide.optional}</span>
          </p>
          <pre className="tabular mt-2 overflow-x-auto rounded bg-background p-2 text-xs">
            {guide.example}
          </pre>
          <p className="mt-2 text-xs text-muted-foreground">
            Extra columns are ignored, so a file exported from another system can be used as it is.
            {kind === 'balances' &&
              ' Opening balances are recorded as receipts, so each one gets a document number and appears in the ledger.'}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="file">CSV file</Label>
          <input
            ref={fileRef}
            id="file"
            type="file"
            accept=".csv,text/csv"
            onChange={async (event) => {
              const file = event.target.files?.[0]
              if (file) setText(await file.text())
            }}
            className="block w-full text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-2 file:text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Or paste the rows below. Nothing is sent until you press Check.
          </p>
        </div>

        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          spellCheck={false}
          rows={8}
          placeholder={guide.example}
          className="tabular w-full rounded-md border border-input bg-background p-3 text-xs"
        />

        {state.error && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}

        <CheckButton disabled={text.trim() === ''} />
      </form>

      {/*
        A separate form, not a nested one. A <form> inside a <form> is invalid
        HTML: the browser drops the inner one, and the button silently does
        nothing — which is exactly what it did the first time.
      */}
      {plan && !state.committed && usable > 0 && (
        <form action={formAction}>
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="text" value={text} />
          <input type="hidden" name="commit" value="true" />
          <CommitButton count={usable} />
        </form>
      )}

      {plan && (
        <div className="space-y-3 rounded-lg border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            {state.committed ? (
              <>
                <CheckCircle2 className="size-4 text-ok" />
                <span className="font-medium">Imported.</span>
                <Badge variant="ok">{plan.applied} applied</Badge>
              </>
            ) : (
              <>
                <FileUp className="size-4 text-muted-foreground" />
                {/* Said plainly: nothing has happened yet. */}
                <span className="font-medium">Nothing has been changed yet.</span>
              </>
            )}

            {plan.create > 0 && <Badge variant="secondary">{plan.create} new</Badge>}
            {plan.update > 0 && <Badge variant="secondary">{plan.update} updated</Badge>}
            {plan.problems.length > 0 && (
              <Badge variant="warn">{plan.problems.length} rows skipped</Badge>
            )}
            {plan.failures.length > 0 && (
              <Badge variant="destructive">{plan.failures.length} failed</Badge>
            )}
          </div>

          {plan.sample.length > 0 && !state.committed && (
            <div>
              <p className="text-sm font-medium">What it would do</p>
              <ul className="mt-1 space-y-0.5 text-sm text-muted-foreground">
                {plan.sample.map((line) => (
                  <li key={line} className="tabular">
                    {line}
                  </li>
                ))}
                {usable > plan.sample.length && <li>…and {usable - plan.sample.length} more.</li>}
              </ul>
            </div>
          )}

          {plan.problems.length > 0 && (
            <div>
              <p className="text-sm font-medium">Rows that will be skipped</p>
              <ul className="mt-1 space-y-0.5 text-sm">
                {plan.problems.slice(0, 50).map((problem) => (
                  <li key={`${problem.line}-${problem.message}`}>
                    <span className="tabular text-muted-foreground">Row {problem.line}:</span>{' '}
                    {problem.message}
                  </li>
                ))}
                {plan.problems.length > 50 && (
                  <li className="text-muted-foreground">
                    …and {plan.problems.length - 50} more.
                  </li>
                )}
              </ul>
            </div>
          )}

          {plan.failures.length > 0 && (
            <div>
              <p className="text-sm font-medium">Rows that failed while applying</p>
              <ul className="mt-1 space-y-0.5 text-sm">
                {plan.failures.map((failure) => (
                  <li key={`${failure.line}-${failure.message}`}>
                    <span className="tabular text-muted-foreground">Row {failure.line}:</span>{' '}
                    {failure.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function CheckButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" variant="outline" disabled={pending || disabled}>
      {pending ? (
        <>
          <Loader2 className="mr-2 size-4 animate-spin" />
          Checking…
        </>
      ) : (
        'Check the file'
      )}
    </Button>
  )
}

function CommitButton({ count }: { count: number }) {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" disabled={pending}>
      {pending ? (
        <>
          <Loader2 className="mr-2 size-4 animate-spin" />
          Importing…
        </>
      ) : (
        <>
          <Upload className="mr-2 size-4" />
          Import {count} row{count === 1 ? '' : 's'}
        </>
      )}
    </Button>
  )
}
