/**
 * Tier 1 scanning: telling a barcode scanner apart from a person typing.
 *
 * Every Zebra Bluetooth scanner — including the RS5100 and RS6000 ring scanners
 * — can pair as an HID keyboard. It types the barcode and sends a terminator.
 * No driver, no SDK, no permission prompt, no browser restriction. That is why
 * this is the universal floor beneath the whole web device layer
 * (DEVICE_INTEGRATION.md §3, WADR-013).
 *
 * The cost is that scans arrive as ordinary keystrokes, so they have to be
 * recognised by TIMING. This module is pure — it takes keystrokes and returns a
 * decision — so the heuristic can be tested against realistic and adversarial
 * input rather than by waving a scanner at a browser.
 */

export interface WedgeOptions {
  /**
   * Maximum gap between characters, in milliseconds.
   *
   * Zebra scanners emit at roughly 5–15 ms per character. A fast human touch
   * typist reaches about 60 ms between keys, and bursts below 30 ms only by
   * accident. 50 ms leaves room for a loaded page or a slow Bluetooth stack
   * without admitting real typing.
   */
  maxGapMs: number
  /** Shorter than this is not a barcode; EAN-8 is the shortest in practice. */
  minLength: number
  /** Longer than this is somebody leaning on a key. */
  maxLength: number
}

export const DEFAULT_WEDGE_OPTIONS: WedgeOptions = {
  maxGapMs: 50,
  minLength: 4,
  maxLength: 128,
}

export type WedgeResult =
  /** A completed scan. The caller should suppress the keystrokes. */
  | { kind: 'SCAN'; data: string }
  /** Part of a possible scan. Suppress and keep buffering. */
  | { kind: 'BUFFERING' }
  /** Not a scan. Let the keystroke through to the page. */
  | { kind: 'PASS_THROUGH' }

export interface KeyEvent {
  key: string
  at: number
}

/**
 * Accumulates keystrokes and decides whether they form a scan.
 *
 * Deliberately a class with explicit state rather than a hook: the same logic
 * has to run in a React provider, in tests, and (later) behind a WebHID adapter
 * that produces the same `BarcodeScan` shape.
 */
export class KeyboardWedge {
  private buffer = ''
  private lastAt = 0
  /**
   * Set when a burst is abandoned for being too long.
   *
   * Without it, clearing the buffer mid-burst lets the REMAINDER of that burst
   * accumulate into a fresh one — so somebody leaning on a key produces a
   * spurious scan of the last few characters. The flag holds until the burst
   * genuinely ends, which is a gap wider than a scanner could produce.
   */
  private abandoned = false

  constructor(private readonly options: WedgeOptions = DEFAULT_WEDGE_OPTIONS) {}

  /** Characters typed so far, for an "armed" indicator. */
  get pending(): string {
    return this.buffer
  }

  reset(): void {
    this.buffer = ''
    this.lastAt = 0
    this.abandoned = false
  }

  accept(event: KeyEvent): WedgeResult {
    const gap = this.lastAt === 0 ? 0 : event.at - this.lastAt

    // A gap wider than a scanner can produce means the burst is over, whatever
    // happened during it.
    if (this.abandoned && gap > this.options.maxGapMs) {
      this.abandoned = false
    }

    // A terminator ends the burst. Enter and Tab are what Zebra scanners send;
    // which one is configured on the device varies by site.
    if (event.key === 'Enter' || event.key === 'Tab') {
      const data = this.abandoned ? '' : this.buffer
      this.reset()

      const longEnough = data.length >= this.options.minLength
      const shortEnough = data.length <= this.options.maxLength

      // A bare Enter with nothing buffered is somebody submitting a form.
      return longEnough && shortEnough ? { kind: 'SCAN', data } : { kind: 'PASS_THROUGH' }
    }

    // Only printable single characters can be part of a barcode. Shift, arrows,
    // Backspace and the rest belong to whoever is typing.
    if (event.key.length !== 1) {
      this.reset()
      return { kind: 'PASS_THROUGH' }
    }

    // Still inside an abandoned burst: swallow nothing, decide nothing.
    if (this.abandoned) {
      this.lastAt = event.at
      return { kind: 'PASS_THROUGH' }
    }

    // Too slow to be a scanner: this is a person. Start a fresh buffer from this
    // character rather than discarding it, because the NEXT few keystrokes may
    // still turn out to be a scan.
    if (gap > this.options.maxGapMs) {
      this.buffer = event.key
      this.lastAt = event.at
      return { kind: 'PASS_THROUGH' }
    }

    this.buffer += event.key
    this.lastAt = event.at

    if (this.buffer.length > this.options.maxLength) {
      this.buffer = ''
      this.abandoned = true
      return { kind: 'PASS_THROUGH' }
    }

    // Below the minimum this might still be typing, so the keystrokes are let
    // through. Once the burst is long enough to be a barcode, they are held back
    // — otherwise a scan into a search box types half the barcode before the
    // terminator arrives and the value is replaced.
    return this.buffer.length >= this.options.minLength
      ? { kind: 'BUFFERING' }
      : { kind: 'PASS_THROUGH' }
  }
}

/**
 * Whether a keystroke should be ignored entirely.
 *
 * A scanner pointed at a textarea or a password box is almost certainly aimed at
 * that field on purpose, and stealing the input would be maddening. Ordinary
 * text and number inputs are NOT excluded: scanning into the item field of a
 * movement form is exactly the intended workflow, and the provider suppresses
 * the raw characters so only the resolved scan lands.
 */
export function shouldIgnoreTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false

  if (target.isContentEditable) return true
  if (target.tagName === 'TEXTAREA') return true
  if (target.tagName === 'SELECT') return true

  if (target instanceof HTMLInputElement) {
    return target.type === 'password' || target.dataset.noScan === 'true'
  }

  return false
}
