'use client'

import { useActionState, useRef, useState, type ReactNode } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, CheckCircle2, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react'
import { bulkBatchStatusAction, type BulkBatchState } from './actions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * Selecting batches and acting on all of them.
 *
 * The table stays a SERVER component and is passed in as children. Selection is
 * native form state — checkboxes named `batchIds` inside this form — so the
 * rows did not have to become client components to gain a checkbox, and they
 * keep rendering on the server as they did.
 *
 * The count is the only thing that needs JavaScript, and if it ever failed to
 * hydrate the form would still submit correctly. That is the right way round.
 */
export function BulkBatchForm({ children }: { children: ReactNode }) {
  const [state, act] = useActionState<BulkBatchState, FormData>(bulkBatchStatusAction, {})
  const [count, setCount] = useState(0)
  const form = useRef<HTMLFormElement>(null)

  const recount = () => {
    const boxes = form.current?.querySelectorAll<HTMLInputElement>('input[name="batchIds"]')
    setCount([...(boxes ?? [])].filter((box) => box.checked).length)
  }

  return (
    <form ref={form} action={act} onChange={recount} className="space-y-3">
      {count > 0 && (
        <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
          <p className="mr-auto text-sm">
            <span className="font-medium">{count}</span> batch{count === 1 ? '' : 'es'} selected
          </p>

          <div className="min-w-56 flex-1 space-y-1.5">
            <label htmlFor="bulk-note" className="text-sm font-medium">
              Note
            </label>
            <Input
              id="bulk-note"
              name="note"
              placeholder="Supplier defect notice, recall reference…"
              maxLength={1000}
            />
          </div>

          {/* Quarantine does NOT move stock. The units stay where they are and
              keep counting towards on-hand; they simply become unusable, which
              is what an investigation needs — find it, freeze it, decide later. */}
          <ActionButton status="QUARANTINE" label="Quarantine" />
          <ActionButton status="ACTIVE" label="Release" />
        </div>
      )}

      {state.error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      {state.result && (
        <Alert>
          <CheckCircle2 className="text-ok" />
          <AlertDescription className="space-y-2">
            <p>
              {state.result.done} changed
              {state.result.skipped > 0 && `, ${state.result.skipped} already there`}
              {state.result.failed > 0 && `, ${state.result.failed} failed`}.
            </p>

            {/* Every row that did not simply succeed is named. "3 failed"
                without saying which three leaves somebody to find them by hand,
                which is the work this screen exists to save. */}
            {state.result.rows.some((row) => row.status !== 'DONE') && (
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {state.result.rows
                  .filter((row) => row.status !== 'DONE')
                  .map((row) => (
                    <li key={row.ref}>
                      <span className="tabular font-medium">{row.ref}</span> — {row.detail}
                    </li>
                  ))}
              </ul>
            )}
          </AlertDescription>
        </Alert>
      )}

      {children}
    </form>
  )
}

function ActionButton({ status, label }: { status: string; label: string }) {
  const { pending } = useFormStatus()

  return (
    <Button
      type="submit"
      name="status"
      value={status}
      variant={status === 'QUARANTINE' ? 'destructive' : 'outline'}
      disabled={pending}
    >
      {pending ? (
        <Loader2 className="animate-spin" />
      ) : status === 'QUARANTINE' ? (
        <ShieldAlert />
      ) : (
        <ShieldCheck />
      )}
      {label}
    </Button>
  )
}
