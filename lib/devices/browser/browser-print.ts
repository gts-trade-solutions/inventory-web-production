/**
 * Tier 3 printing: Zebra Browser Print.
 *
 * A printer attached by USB or Bluetooth to one workstation cannot be reached
 * by the server — there is no address to open a socket to. Zebra's Browser
 * Print utility bridges that: it runs on the workstation and exposes a small
 * HTTP API on localhost that a page can call.
 *
 * So this is the one printing path that runs in the BROWSER rather than on the
 * server (WADR-014), and it is strictly optional. If the utility is not
 * installed, the printer simply does not appear in the picker, and networked
 * printing still works for everyone.
 *
 * Detected at runtime rather than configured, because whether it is installed
 * is a property of the machine somebody happens to be sitting at, not of the
 * deployment.
 */

/**
 * Browser Print listens on localhost.
 *
 * It serves HTTP on 9100 and HTTPS on 9101. A page served over HTTPS cannot
 * call the HTTP one — mixed content — so both are tried, HTTPS first when the
 * page itself is secure. Getting this backwards produces a "not installed"
 * message on a machine where it is installed and running.
 */
const ENDPOINTS = ['https://localhost:9101', 'http://localhost:9100'] as const

/** Long enough for a busy utility, short enough not to stall the print screen. */
const PROBE_TIMEOUT_MS = 1_500
const PRINT_TIMEOUT_MS = 10_000

export interface LocalPrinter {
  uid: string
  name: string
  connection: string
  deviceType: string
}

export class BrowserPrintError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrowserPrintError'
  }
}

/** Endpoints to try, most likely first for this page's protocol. */
export function endpointsFor(pageProtocol: string): readonly string[] {
  return pageProtocol === 'https:' ? ENDPOINTS : [...ENDPOINTS].reverse()
}

interface FetchLike {
  (input: string, init?: { signal?: AbortSignal; method?: string; body?: string }): Promise<{
    ok: boolean
    status: number
    text(): Promise<string>
  }>
}

export interface BrowserPrintOptions {
  fetch?: FetchLike
  protocol?: string
  probeTimeoutMs?: number
  printTimeoutMs?: number
}

/**
 * The client for the local utility.
 *
 * `fetch` is injectable so the request/response handling — which is where the
 * mistakes are — can be tested without installing Zebra's utility. What that
 * cannot prove is how a real installation behaves on a real workstation
 * (DEVICE_INTEGRATION §11.2).
 */
export class BrowserPrint {
  private readonly fetch: FetchLike
  private readonly protocol: string
  private readonly probeTimeoutMs: number
  private readonly printTimeoutMs: number
  private base: string | null = null

  constructor(options: BrowserPrintOptions = {}) {
    this.fetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike)
    this.protocol =
      options.protocol ??
      (typeof location === 'undefined' ? 'http:' : location.protocol)
    this.probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS
    this.printTimeoutMs = options.printTimeoutMs ?? PRINT_TIMEOUT_MS
  }

  /** Whether the utility is running here. Never throws. */
  async available(): Promise<boolean> {
    return (await this.discover()) !== null
  }

  /**
   * The printers this workstation can reach.
   *
   * An empty list when the utility is absent, not an error. "No local printers"
   * is the normal state on most machines, and an error would make every one of
   * them look broken.
   */
  async printers(): Promise<LocalPrinter[]> {
    const base = await this.discover()
    if (!base) return []

    try {
      const response = await this.request(`${base}/available`, this.probeTimeoutMs)
      if (!response.ok) return []

      const body = JSON.parse(await response.text()) as {
        printer?: LocalPrinter[]
        device?: LocalPrinter[]
      }

      // The utility has used both keys across versions.
      return body.printer ?? body.device ?? []
    } catch {
      return []
    }
  }

  /**
   * Sends ZPL to a local printer.
   *
   * Like TCP 9100, this is fire-and-forget: a 200 means the utility accepted
   * the bytes, not that a label came out. The caller must say "sent", not
   * "printed" (DEVICE_INTEGRATION §6).
   */
  async print(printerUid: string, zpl: string): Promise<{ sent: true; bytes: number }> {
    const base = await this.discover()
    if (!base) {
      throw new BrowserPrintError(
        'Zebra Browser Print is not running on this machine. Install it, or choose a networked printer.',
      )
    }

    const response = await this.request(
      `${base}/write`,
      this.printTimeoutMs,
      JSON.stringify({ device: { uid: printerUid }, data: zpl }),
    )

    if (!response.ok) {
      throw new BrowserPrintError(
        `Browser Print refused the job (HTTP ${response.status}). Check the printer is switched on and selected in the utility.`,
      )
    }

    return { sent: true, bytes: new TextEncoder().encode(zpl).length }
  }

  /** Forgets the discovered endpoint, so the next call probes again. */
  forget(): void {
    this.base = null
  }

  private async discover(): Promise<string | null> {
    if (this.base) return this.base

    for (const endpoint of endpointsFor(this.protocol)) {
      try {
        const response = await this.request(`${endpoint}/available`, this.probeTimeoutMs)
        if (response.ok) {
          this.base = endpoint
          return endpoint
        }
      } catch {
        // Not there, or the wrong protocol. Try the next.
      }
    }

    return null
  }

  private async request(url: string, timeoutMs: number, body?: string) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      return await this.fetch(url, {
        signal: controller.signal,
        ...(body === undefined ? {} : { method: 'POST', body }),
      })
    } finally {
      // Always cleared. A leaked timer per probe adds up on a screen that
      // re-checks whenever the printer list is opened.
      clearTimeout(timer)
    }
  }
}
