'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, CheckCircle2, Loader2, RotateCcw } from 'lucide-react'
import { resetDemoAction, type DemoResetState } from './actions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * One-click reset of the demo data.
 *
 * Confirmation is deliberately a second click rather than a dialog: it is the
 * same guard, it cannot be dismissed by accident, and it keeps the consequence
 * visible on screen while the operator decides (DEMO_MODE §7.6).
 */
export function DemoReset() {
  const [state, formAction] = useActionState<DemoResetState, FormData>(resetDemoAction, {})
  const [confirming, setConfirming] = useState(false)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RotateCcw className="size-4 text-muted-foreground" />
          Reset the demo data
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Puts the demo database back to its seeded state: the same items, batches, serial units and
          devices every time, so a rehearsed demonstration still matches the screen.
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
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

        {confirming ? (
          <form action={formAction} className="flex flex-wrap items-center gap-3">
            <p className="w-full text-sm">
              {/* Named plainly. "Are you sure?" does not say what is lost. */}
              Everything recorded in Demo mode since the last reset will be destroyed — movements,
              counts, print jobs and any items added. Live data is untouched.
            </p>
            <ConfirmButton />
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <Button type="button" variant="outline" onClick={() => setConfirming(true)}>
            <RotateCcw className="mr-2 size-4" />
            Reset demo data
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

function ConfirmButton() {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" variant="destructive" disabled={pending}>
      {pending ? (
        <>
          <Loader2 className="mr-2 size-4 animate-spin" />
          Reseeding…
        </>
      ) : (
        'Yes, reset it'
      )}
    </Button>
  )
}
