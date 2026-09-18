/**
 * The hardware bring-up rehearsal.
 *
 *   npm run bringup
 *
 * Runs the real connectors — the same `TcpPrinter` and `LlrpReader` that talk
 * to an FX9600 — against the protocol-level simulators, and prints the bring-up
 * record exactly as hardware day will print it.
 *
 * The point is not to test the connectors; the test suite does that. The point
 * is that on the day the devices arrive, somebody will run `selfTest()` against
 * a real printer and have to decide whether what came back is normal. That
 * decision is much easier with a known-good record to compare against, produced
 * by the same code — and much harder at 9am in a warehouse with a box of Zebras
 * and no reference.
 *
 * So this also rehearses the failures. A printer that accepts the connection
 * and then says nothing, and a host that is not there at all, are the two
 * things most likely to happen first, and both should be recognised from the
 * output rather than diagnosed from scratch.
 *
 * DEVICE_INTEGRATION.md §12 is the checklist this belongs to.
 */

import { TcpPrinter } from '../lib/devices/server/tcp-printer'
import { LlrpReader } from '../lib/devices/server/llrp-reader'
import { startFakePrinter, HEALTHY_STATUS } from '../tests/helpers/fake-printer'
import { startFakeLlrpReader } from '../tests/helpers/fake-llrp-reader'
import type { SelfTestOutcome, SelfTestReport } from '../lib/devices/printer'

const MARK: Record<SelfTestOutcome, string> = {
  PASSED: '  ok  ',
  FAILED: ' FAIL ',
  /** Ran, proved nothing. The state bring-up most needs to see. */
  INCONCLUSIVE: '  ??  ',
}

function print(report: SelfTestReport, note?: string) {
  console.log(`\n${report.device}${note ? `  — ${note}` : ''}`)
  console.log('-'.repeat(78))

  for (const step of report.steps) {
    console.log(`[${MARK[step.outcome]}] ${step.name.padEnd(34)} ${step.ms}ms`)
    // The detail is the record. A boolean would not be worth writing down.
    for (const line of wrap(step.detail, 72)) console.log(`         ${line}`)
  }

  console.log(`         => ${report.outcome}`)
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  let current = ''

  for (const word of text.split(' ')) {
    if (current.length + word.length + 1 > width) {
      lines.push(current)
      current = word
    } else {
      current = current ? `${current} ${word}` : word
    }
  }
  if (current) lines.push(current)

  return lines
}

/**
 * A handful of tags, as a controlled read of known stock would produce.
 *
 * Built fresh on each report because a real reader timestamps every read, and
 * the timestamp is what the connector uses to order them.
 */
function tags() {
  const at = new Date()

  return [
    { epc: '3034F4A2C0E40000000004D2', rssi: -52, antenna: 1, at },
    { epc: '3034F4A2C0E40000000004D3', rssi: -61, antenna: 1, at },
    { epc: '3034F4A2C0E40000000004D4', rssi: -58, antenna: 2, at },
  ]
}

async function printerRehearsal() {
  console.log('\n\n=== PRINTER ' + '='.repeat(65))

  // 1. A healthy printer.
  const healthy = await startFakePrinter()
  healthy.respondToStatusWith(HEALTHY_STATUS)

  const printer = new TcpPrinter({ host: '127.0.0.1', port: healthy.port, label: 'Bay 1 printer' })
  print(await printer.selfTest(), 'a healthy printer')

  console.log(`\n         Jobs the printer actually received: ${healthy.jobs.length}`)
  console.log(`         The test label began: ${healthy.jobs[0]?.slice(0, 24) ?? '(none)'}…`)
  await healthy.close()

  // 2. Out of paper. The status line is the whole value of ~HS: the socket
  //    opens and the job is accepted either way.
  const empty = await startFakePrinter()
  empty.respondToStatusWith(
    '030,1,0,0317,000,0,0,0,000,0,0,0\r\n001,0,0,0,0,2,6,0,00000000,1,000\r\n1234,0\r\n',
  )
  const outOfPaper = new TcpPrinter({ host: '127.0.0.1', port: empty.port, label: 'Bay 2 printer' })
  print(await outOfPaper.selfTest(), 'out of paper — note the job is still accepted')
  await empty.close()

  // 3. Accepts the connection, then says nothing. Real models do this, and it
  //    is the failure most likely to be misread as "the network is fine".
  const silent = await startFakePrinter({ kind: 'SILENT' })
  const quiet = new TcpPrinter({
    host: '127.0.0.1',
    port: silent.port,
    label: 'Bay 3 printer',
    replyTimeoutMs: 1_000,
  })
  print(await quiet.selfTest(), 'connects, then never answers ~HS')
  await silent.close()

  // 4. Nothing there at all. Port 1 is reserved and nothing listens on it.
  const absent = new TcpPrinter({
    host: '127.0.0.1',
    port: 1,
    label: 'Bay 4 printer',
    connectTimeoutMs: 1_000,
  })
  print(await absent.selfTest(), 'wrong address, or powered off')
}

async function readerRehearsal() {
  console.log('\n\n=== RFID READER ' + '='.repeat(61))

  // 1. A reader with tagged stock in range.
  const reader = await startFakeLlrpReader()
  const fx = new LlrpReader({
    host: '127.0.0.1',
    port: reader.port,
    label: 'Dock door reader',
    selfTestInventoryMs: 1_000,
  })

  // Tags arrive while the sweep is running, as they would from a real antenna.
  const pushing = setInterval(() => reader.report(tags()), 200)
  const report = await fx.selfTest()
  clearInterval(pushing)

  print(report, 'tagged stock in range')
  console.log(`\n         LLRP messages the reader received: ${reader.received.join(', ')}`)
  await reader.close()

  // 2. Connects and configures, but sees nothing. Antennas, power, or simply
  //    no tagged stock in range — the report says which things to check.
  const quiet = await startFakeLlrpReader()
  const silent = new LlrpReader({
    host: '127.0.0.1',
    port: quiet.port,
    label: 'Aisle 4 reader',
    selfTestInventoryMs: 1_000,
  })
  print(await silent.selfTest(), 'connected, but no tags seen')
  await quiet.close()

  // 3. Not there.
  const absent = new LlrpReader({
    host: '127.0.0.1',
    port: 1,
    label: 'Aisle 9 reader',
    connectTimeoutMs: 1_000,
  })
  print(await absent.selfTest(), 'wrong address, or not on this network')
}

async function main() {
  console.log('Hardware bring-up rehearsal')
  console.log(
    'The real connectors, run against the protocol simulators. This is what the\n' +
      'bring-up record looks like when it goes well — and when it does not.',
  )

  await printerRehearsal()
  await readerRehearsal()

  console.log('\n\n=== SCANNER ' + '='.repeat(65))
  console.log(
    '\nScanners cannot be rehearsed from a script: Tier 1 is keystrokes into a\n' +
      'focused input and Tier 2 is a WebHID permission prompt, both of which need\n' +
      'a browser and a person. The scan screen in demo mode exercises the same\n' +
      'parsing path, and lib/devices/browser/hid-pos.test.ts pins the report\n' +
      'formats. On the day: configure HID mode and the terminator first, then\n' +
      'Tier 1, then attempt WebHID. Tier 1 working is the bar; WebHID is a bonus.',
  )

  console.log('\n\n' + '='.repeat(78))
  console.log(
    'On hardware day, run selfTest() from the Devices screen against each real\n' +
      'device and compare with the above. Record the output against the device —\n' +
      'that IS the bring-up record (DEVICE_INTEGRATION.md §12).',
  )
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
