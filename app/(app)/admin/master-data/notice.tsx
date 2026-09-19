'use client'

import { AlertCircle, CheckCircle2 } from 'lucide-react'
import type { MasterDataState } from './actions'
import { Alert, AlertDescription } from '@/components/ui/alert'

/**
 * The result of the last action in a section.
 *
 * Shared because the three sections on this page all report the same way, and
 * because the refusals here are the interesting part: "that would hide stock
 * from every picker" is the sentence somebody needs, and it has to be visible
 * rather than swallowed into a generic failure.
 */
export function Notice({ state }: { state: MasterDataState }) {
  if (state.error) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertDescription>{state.error}</AlertDescription>
      </Alert>
    )
  }

  if (state.message) {
    return (
      <Alert>
        <CheckCircle2 className="text-ok" />
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    )
  }

  return null
}

/**
 * The most recent of several action states, so one notice serves a section.
 *
 * By `at`, not by argument order. Taking the first state with something in it
 * meant a successful create went on masking every later error: the refusal
 * from a deactivate arrived, the server had done the right thing, and the
 * screen still showed "X added." The user clicks, is refused, and sees
 * nothing — which reads as the button being broken.
 */
export function latest(...states: MasterDataState[]): MasterDataState {
  return (
    states
      .filter((state) => state.error || state.message)
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0] ?? {}
  )
}
