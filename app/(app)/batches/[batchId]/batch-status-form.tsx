'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
// NOT `import { BatchStatus } from '@prisma/client'`. That is a runtime value
// import, and pulling the Prisma client into a browser bundle makes webpack
// resolve the module to undefined — which surfaces as
// "Cannot read properties of undefined (reading 'call')" in layout-router, with
// no hint about where it came from. A client component may import Prisma TYPES
// (erased at compile time) but never its values.
import { AlertCircle, CheckCircle2, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react'

/** Mirrors the Prisma enum. String values are identical, so they interchange. */
type BatchStatus = 'ACTIVE' | 'QUARANTINE' | 'EXPIRED' | 'BLOCKED' | 'CONSUMED'
import { setBatchStatusAction, type BatchActionState } from './actions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * Quarantine or release, for a supervisor.
 *
 * The copy spells out what quarantining does and does not do, because the
 * intuitive reading — "it removes the stock" — is wrong, and acting on that
 * belief during a recall is expensive.
 */
export function BatchStatusForm({
  batchId,
  batchNo,
  status,
}: {
  batchId: string
  batchNo: string
  status: BatchStatus
}) {
  const [state, formAction] = useActionState<BatchActionState, FormData>(setBatchStatusAction, {})

  const quarantined = status === 'QUARANTINE' || status === 'BLOCKED'
  const nextStatus = quarantined ? 'ACTIVE' : 'QUARANTINE'

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="batchId" value={batchId} />
      <input type="hidden" name="status" value={nextStatus} />

      <p className="text-sm text-muted-foreground">
        {quarantined
          ? `${batchNo} cannot be issued. Releasing it makes it usable again.`
          : `Quarantining ${batchNo} leaves its stock on the shelf and still counted, but blocks it from being issued until it is released.`}
      </p>

      {!quarantined && (
        <Input name="note" placeholder="Why? (e.g. supplier recall SR-2026-14)" maxLength={1000} />
      )}

      {state.error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      {state.message && (
        <Alert>
          <CheckCircle2 className="text-ok" />
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      <SubmitButton quarantined={quarantined} />
    </form>
  )
}

function SubmitButton({ quarantined }: { quarantined: boolean }) {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" variant={quarantined ? 'default' : 'destructive'} disabled={pending}>
      {pending ? (
        <Loader2 className="animate-spin" />
      ) : quarantined ? (
        <ShieldCheck />
      ) : (
        <ShieldAlert />
      )}
      {quarantined ? 'Release batch' : 'Quarantine batch'}
    </Button>
  )
}
