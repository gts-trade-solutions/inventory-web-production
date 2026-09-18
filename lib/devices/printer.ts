/**
 * What a printer connector has to be able to do, whatever it is talking to.
 *
 * Three implementations satisfy this: a networked printer over TCP 9100, a
 * locally attached one through Zebra Browser Print, and a simulator. Nothing
 * above this layer knows which one it has — that is what lets the same print
 * button work on a demo laptop and on the warehouse floor (WADR-013).
 *
 * No node or Prisma imports: the type is shared with client components.
 */

export const PrintOutcome = {
  /** The bytes left us and the connection closed cleanly. */
  SENT: 'SENT',
  /** The printer told us it printed. Only some models can say this. */
  CONFIRMED: 'CONFIRMED',
  FAILED: 'FAILED',
} as const
export type PrintOutcome = (typeof PrintOutcome)[keyof typeof PrintOutcome]

export interface PrintResult {
  outcome: PrintOutcome
  /** Labels the document prints, counted from the ZPL itself. */
  labels: number
  bytesSent: number
  ms: number
  /**
   * What we actually know, in the operator's words.
   *
   * TCP 9100 is fire-and-forget by nature: the socket closing means the printer
   * accepted the bytes, not that a label came out. Saying "Printed" when we only
   * know "Sent" is how somebody ends up looking for a label that never existed
   * (DEVICE_INTEGRATION §6).
   */
  message: string
  error?: string
}

/**
 * A printer's own account of itself, from `~HS`.
 *
 * Every field is optional because support varies by model and firmware. An
 * absent field means "this printer did not tell us", which is different from
 * "no" — and the UI must not render the two the same way.
 */
export interface PrinterStatus {
  online: boolean
  paperOut?: boolean
  headOpen?: boolean
  paused?: boolean
  raw?: string
}

/**
 * How a self-test step turned out.
 *
 * Three states, not two. A step that ran without error but did not exercise the
 * thing it exists to check — an inventory sweep that saw no tags at all — has
 * not passed, and saying it did is how somebody ticks "reader verified" on the
 * bring-up checklist with an antenna cable hanging loose. It has also not
 * failed: an empty aisle is not a fault, and a reader that showed red whenever
 * nothing was in range would be ignored within a week.
 *
 * INCONCLUSIVE is the honest third answer, and it is the one bring-up needs.
 */
export const SelfTestOutcome = {
  PASSED: 'PASSED',
  FAILED: 'FAILED',
  /** Ran, but proved nothing. Says what to put in range and try again. */
  INCONCLUSIVE: 'INCONCLUSIVE',
} as const
export type SelfTestOutcome = (typeof SelfTestOutcome)[keyof typeof SelfTestOutcome]

export interface SelfTestStep {
  name: string
  outcome: SelfTestOutcome
  /** What happened, not whether it passed. This is the bring-up record. */
  detail: string
  ms: number
}

export interface SelfTestReport {
  device: string
  outcome: SelfTestOutcome
  steps: SelfTestStep[]
}

/**
 * The report's outcome, from its steps: any failure fails, and anything
 * unproven leaves the whole test unproven.
 */
export function summarise(steps: readonly SelfTestStep[]): SelfTestOutcome {
  // No steps demonstrates nothing. Defaulting that to PASSED would make a
  // connector that ran no checks at all look verified, which is the one
  // direction this must never fail in.
  if (steps.length === 0) return SelfTestOutcome.INCONCLUSIVE

  if (steps.some((step) => step.outcome === SelfTestOutcome.FAILED)) return SelfTestOutcome.FAILED
  if (steps.some((step) => step.outcome === SelfTestOutcome.INCONCLUSIVE)) {
    return SelfTestOutcome.INCONCLUSIVE
  }

  return SelfTestOutcome.PASSED
}

export interface PrinterConnector {
  readonly label: string
  readonly simulated: boolean

  print(zpl: string): Promise<PrintResult>
  status(): Promise<PrinterStatus>
  /**
   * Runs the bring-up sequence and reports each step.
   *
   * Returns a report rather than a boolean: on hardware day the useful answer is
   * "the socket opened but ~HS timed out", not "false".
   */
  selfTest(): Promise<SelfTestReport>
}
