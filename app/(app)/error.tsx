'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { Lock, ServerCrash } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

/**
 * The console's error boundary.
 *
 * A permission failure is not a crash. `requireRole()` throws so that a handler
 * cannot accidentally continue without the right role, but the person on the
 * other end should be told they lack access — not shown "something went wrong",
 * which reads like our fault and invites them to retry.
 *
 * Everything else is genuinely unexpected and says so, with the digest Next
 * assigns so a server log can be found from a screenshot.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // The real error is already server-side; this is the client's copy.
    console.error(error)
  }, [error])

  const forbidden = /needs .* access|No access to site/i.test(error.message)

  return (
    <div className="mx-auto flex max-w-lg items-center justify-center py-16">
      <Card className="w-full">
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          {forbidden ? (
            <>
              <Lock className="size-8 text-muted-foreground" />
              <p className="text-lg font-medium">You do not have access to this</p>
              <p className="text-sm text-muted-foreground">
                Your account does not have the role this page needs. An administrator can change
                that.
              </p>
              <Button asChild className="mt-2">
                <Link href="/dashboard">Back to the dashboard</Link>
              </Button>
            </>
          ) : (
            <>
              <ServerCrash className="size-8 text-destructive" />
              <p className="text-lg font-medium">Something went wrong on our side</p>
              <p className="text-sm text-muted-foreground">
                Nothing was saved. Try again, and if it keeps happening quote this reference.
              </p>
              {error.digest && (
                <p className="tabular rounded bg-muted px-2 py-1 text-xs">{error.digest}</p>
              )}
              <div className="mt-2 flex gap-2">
                <Button onClick={reset}>Try again</Button>
                <Button asChild variant="outline">
                  <Link href="/dashboard">Dashboard</Link>
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
