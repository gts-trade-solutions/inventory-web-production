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

/** The most recent of several action states, so one notice serves a section. */
export function latest(...states: MasterDataState[]): MasterDataState {
  return states.find((state) => state.error || state.message) ?? {}
}
