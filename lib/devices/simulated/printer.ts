import { labelCount, validateZpl } from '@/lib/labels/zpl'
import {
  PrintOutcome,
  SelfTestOutcome,
  summarise,
  type PrinterConnector,
  type PrinterStatus,
  type PrintResult,
  type SelfTestReport,
  type SelfTestStep,
} from '../printer'

/**
 * A printer that exists only in memory.
 *
 * Mirrors the mobile app's `SimulatedLabelPrinter`, and for the same reason:
 * every workflow is demoable and testable without hardware, so development is
 * not blocked waiting for devices to arrive (DEVICE_INTEGRATION §8).
 *
 * It validates the ZPL exactly as the real connector does and keeps what it was
 * given, so a label preview in Demo mode is the same bytes a printer would have
 * received. A simulator that accepted anything would let a broken template reach
 * hardware day unnoticed.
 *
 * `simulated` is true and the UI always says so. That transparency is the whole
 * reason simulators are safe to leave enabled in staging.
 */

export interface SimulatedPrintJob {
  zpl: string
  labels: number
  at: Date
}

export class SimulatedPrinter implements PrinterConnector {
  readonly simulated = true
  readonly label: string

  private readonly jobs: SimulatedPrintJob[] = []
  private failNext: string | null = null
  private state: PrinterStatus = { online: true, paperOut: false, headOpen: false, paused: false }

  constructor(label = 'Simulated printer') {
    this.label = label
  }

  /** What has been "printed", for the preview and the demo device console. */
  history(): readonly SimulatedPrintJob[] {
    return this.jobs
  }

  /**
   * Makes the next job fail.
   *
   * Demo mode has to be able to show the unhappy path. An operator who has only
   * ever seen printing succeed does not know what the screen looks like when the
   * printer is off, which is precisely the moment they need to recognise it.
   */
  failNextJob(reason: string): void {
    this.failNext = reason
  }

  setState(state: Partial<PrinterStatus>): void {
    this.state = { ...this.state, ...state }
  }

  async print(zpl: string): Promise<PrintResult> {
    const started = Date.now()

    try {
      validateZpl(zpl)
    } catch (error) {
      return {
        outcome: PrintOutcome.FAILED,
        labels: 0,
        bytesSent: 0,
        ms: Date.now() - started,
        message: 'This label was not sent, because a printer could not have used it.',
        error: error instanceof Error ? error.message : String(error),
      }
    }

    if (this.failNext) {
      const error = this.failNext
      this.failNext = null
      return {
        outcome: PrintOutcome.FAILED,
        labels: 0,
        bytesSent: 0,
        ms: Date.now() - started,
        message: `Could not print to ${this.label}.`,
        error,
      }
    }

    if (this.state.paperOut || this.state.headOpen) {
      return {
        outcome: PrintOutcome.FAILED,
        labels: 0,
        bytesSent: 0,
        ms: Date.now() - started,
        message: `Could not print to ${this.label}.`,
        error: this.state.paperOut ? 'The printer is out of labels.' : 'The print head is open.',
      }
    }

    const labels = labelCount(zpl)
    this.jobs.push({ zpl, labels, at: new Date() })

    return {
      outcome: PrintOutcome.CONFIRMED,
      labels,
      bytesSent: Buffer.byteLength(zpl, 'utf8'),
      ms: Date.now() - started,
      // A simulator genuinely knows the label "printed", which a real TCP 9100
      // printer does not. Saying so keeps the distinction visible rather than
      // teaching people to read SENT as PRINTED.
      message: `Printed ${labels} label${labels === 1 ? '' : 's'} on ${this.label} (simulation).`,
    }
  }

  async status(): Promise<PrinterStatus> {
    return { ...this.state }
  }

  async selfTest(): Promise<SelfTestReport> {
    const result = await this.print(
      ['^XA^CI28', '^CF0,36^FO40,40^FDInventory test label^FS', '^XZ'].join('\n'),
    )

    const steps: SelfTestStep[] = [
      {
        name: 'Open socket',
        outcome: SelfTestOutcome.PASSED,
        detail: 'Simulated printer — no network involved.',
        ms: 0,
      },
      {
        name: 'Query status (~HS)',
        outcome: this.state.online ? SelfTestOutcome.PASSED : SelfTestOutcome.FAILED,
        detail: this.state.paperOut ? 'Reports out of labels.' : 'Reports no problems.',
        ms: 0,
      },
      {
        name: 'Print a test label',
        outcome:
          result.outcome === PrintOutcome.FAILED ? SelfTestOutcome.FAILED : SelfTestOutcome.PASSED,
        detail: result.error ?? result.message,
        ms: result.ms,
      },
    ]

    return { device: this.label, outcome: summarise(steps), steps }
  }
}
