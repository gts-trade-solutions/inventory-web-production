'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, CheckCircle2, Loader2, ThumbsDown, ThumbsUp } from 'lucide-react'
import { approveCountAction, rejectCountAction, type CountActionState } from '../actions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * Approve or reject a submitted count.
 *
 * Approving is the only thing in the system that turns a count into stock
 * movements, so the button says what it will do to the ledger rather than just
 * "Approve". Rejecting posts nothing at all — the location is recounted.
 */
export function ReviewActions({
  sessionId,
  netUnits,
  lineCount,
}: {
  sessionId: string
  netUnits: number
  lineCount: number
}) {
  const [approveState, approve] = useActionState<CountActionState, FormData>(approveCountAction, {})
  const [rejectState, reject] = useActionState<CountActionState, FormData>(rejectCountAction, {})
  const [rejecting, setRejecting] = useState(false)

  const state = approveState.message || approveState.error ? approveState : rejectState

  if (state.message) {
    return (
      <Alert>
        <CheckCircle2 className="text-ok" />
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="space-y-3">
      {state.error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <p className="text-sm text-muted-foreground">
        {lineCount === 0
          ? 'This count found nothing to correct.'
          : netUnits === 0
            ? 'The variances cancel out overall, but individual lines are still wrong. Approving posts a correction for each.'
            : `Approving posts corrections totalling ${netUnits > 0 ? '+' : ''}${netUnits} units to the ledger.`}
      </p>

      <div className="flex flex-wrap gap-2">
        <form action={approve}>
          <input type="hidden" name="sessionId" value={sessionId} />
          <ApproveButton />
        </form>

        {!rejecting ? (
          <Button type="button" variant="outline" onClick={() => setRejecting(true)}>
            <ThumbsDown />
            Reject
          </Button>
        ) : (
          <form action={reject} className="flex flex-1 flex-wrap items-center gap-2">
            <input type="hidden" name="sessionId" value={sessionId} />
            <Input
              name="note"
              placeholder="Why? (e.g. recount aisle A, figures look wrong)"
              className="min-w-56 flex-1"
              autoFocus
            />
            <RejectButton />
            <Button type="button" variant="ghost" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
          </form>
        )}
      </div>
    </div>
  )
}

function ApproveButton() {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" disabled={pending}>
      {pending ? <Loader2 className="animate-spin" /> : <ThumbsUp />}
      {pending ? 'Posting…' : 'Approve and post'}
    </Button>
  )
}

function RejectButton() {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" variant="destructive" disabled={pending}>
      {pending ? <Loader2 className="animate-spin" /> : <ThumbsDown />}
      Reject
    </Button>
  )
}
