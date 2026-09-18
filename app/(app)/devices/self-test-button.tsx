'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, CheckCircle2, Loader2, Stethoscope, XCircle } from 'lucide-react'
import { runSelfTestAction, type SelfTestState } from './actions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

/**
 * Runs a device's bring-up sequence and shows what happened at each step.
 *
 * Deliberately not a green tick or a red cross. On hardware day the useful
 * answer is "the socket opened but ~HS timed out" — that tells somebody which
 * cable to look at. A boolean tells them to open a ticket
 * (DEVICE_INTEGRATION §11.3).
 */
export function SelfTestButton({
  deviceId,
  label,
  disabled,
}: {
  deviceId: string
  label: string
  disabled?: boolean
}) {
  const [state, formAction] = useActionState<SelfTestState, FormData>(runSelfTestAction, {})

  return (
    <div className="w-full sm:w-auto sm:min-w-80">
      <form action={formAction} className="flex justify-end">
        <input type="hidden" name="deviceId" value={deviceId} />
        <SubmitButton disabled={disabled} label={label} />
      </form>

      {state.error && (
        <Alert variant="destructive" className="mt-3">
          <AlertCircle className="size-4" />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      {state.report && (
        <div className="mt-3 space-y-2 rounded-lg border bg-muted/30 p-3">
          {state.report.steps.map((step) => (
            <div key={step.name} className="flex gap-2 text-sm">
              {step.ok ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" />
              ) : (
                <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
              )}
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium">{step.name}</span>
                  <span className="tabular text-xs text-muted-foreground">{step.ms}ms</span>
                </div>
                {/* What actually happened — this is the bring-up record. */}
                <p className="text-muted-foreground">{step.detail}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SubmitButton({ disabled, label }: { disabled?: boolean; label: string }) {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" variant="outline" size="sm" disabled={pending || disabled}>
      {pending ? (
        <>
          <Loader2 className="mr-2 size-4 animate-spin" />
          Testing…
        </>
      ) : (
        <>
          <Stethoscope className="mr-2 size-4" />
          Self-test
        </>
      )}
      <span className="sr-only"> {label}</span>
    </Button>
  )
}
