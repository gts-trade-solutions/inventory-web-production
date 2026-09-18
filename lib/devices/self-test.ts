import { SelfTestOutcome, type SelfTestStep } from './printer'

/**
 * Running one step of a bring-up sequence.
 *
 * Shared by the printer and reader connectors, which had a copy each. Not for
 * tidiness: the two copies had already drifted in how they timed a step, and
 * the timings are part of the bring-up record somebody compares against.
 */

/** Returned by a step that ran but did not prove what it set out to prove. */
export interface Unproven {
  readonly unproven: true
  readonly detail: string
}

export function unproven(detail: string): Unproven {
  return { unproven: true, detail }
}

export async function step(
  name: string,
  run: () => Promise<string | Unproven>,
): Promise<SelfTestStep> {
  const started = Date.now()

  try {
    const result = await run()
    const ms = Date.now() - started

    return typeof result === 'string'
      ? { name, outcome: SelfTestOutcome.PASSED, detail: result, ms }
      : { name, outcome: SelfTestOutcome.INCONCLUSIVE, detail: result.detail, ms }
  } catch (error) {
    return {
      name,
      outcome: SelfTestOutcome.FAILED,
      // The message, not a stack: this is read by whoever is holding the cable.
      detail: error instanceof Error ? error.message : String(error),
      ms: Date.now() - started,
    }
  }
}
