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

export interface SelfTestStep {
  name: string
  ok: boolean
  /** What happened, not whether it passed. This is the bring-up record. */
  detail: string
  ms: number
}

export interface SelfTestReport {
  device: string
  ok: boolean
  steps: SelfTestStep[]
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
