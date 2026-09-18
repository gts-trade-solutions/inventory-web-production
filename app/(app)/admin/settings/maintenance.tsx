'use client'

import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, Wrench } from 'lucide-react'
import {
  rebuildProjectionAction,
  runSweepAction,
  type MaintenanceState,
} from './maintenance-actions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * Checking that the projection still matches the ledger.
 *
 * The check reports; it does not repair. A rebuild erases the evidence of
 * whatever caused the drift, which is the part worth investigating — so the two
 * are separate buttons and the second one appears only once there is something
 * to repair.
 */
export function Maintenance() {
  const [state, setState] = useState<MaintenanceState>({})
  const [busy, setBusy] = useState<'check' | 'rebuild' | null>(null)

  const run = async (which: 'check' | 'rebuild') => {
    setBusy(which)
    try {
      setState(which === 'check' ? await runSweepAction() : await rebuildProjectionAction())
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Wrench className="size-4 text-muted-foreground" />
          Stock integrity
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Stock levels are a projection of the ledger, and the two agreeing is what makes the
          numbers trustworthy. This checks them, and marks batches whose expiry date has passed.
        </p>
      </CardHeader>

      <CardContent className="space-y-3">
        {state.error && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}

        {state.message && (
          <Alert variant={state.driftRows ? 'destructive' : undefined}>
            {state.driftRows ? (
              <AlertTriangle className="size-4" />
            ) : (
              <CheckCircle2 className="size-4 text-ok" />
            )}
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={() => void run('check')} disabled={busy !== null}>
            {busy === 'check' ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Checking…
              </>
            ) : (
              'Check now'
            )}
          </Button>

          {/* Only once there is something to repair. */}
          {(state.driftRows ?? 0) > 0 && (
            <Button
              type="button"
              variant="destructive"
              onClick={() => void run('rebuild')}
              disabled={busy !== null}
            >
              {busy === 'rebuild' ? (
                <>
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  Rebuilding…
                </>
              ) : (
                'Rebuild from the ledger'
              )}
            </Button>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          This also runs unattended: point a scheduler at{' '}
          <span className="tabular">POST /api/v1/maintenance/sweep</span> nightly.
        </p>
      </CardContent>
    </Card>
  )
}
