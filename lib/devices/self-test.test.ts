import { describe, expect, it } from 'vitest'
import { SelfTestOutcome, summarise } from './printer'
import { step, unproven } from './self-test'

/**
 * Self-test outcomes.
 *
 * Three states rather than two, because "ran but proved nothing" is a real
 * answer and the bring-up checklist depends on telling it apart from "worked".
 * A reader in an empty aisle has not failed; it has also not been verified, and
 * only one of those two mistakes gets a device signed off with its antenna
 * unplugged.
 */

describe('step', () => {
  it('passes when the step returns what happened', async () => {
    const result = await step('Connect', async () => 'Connected on port 5084.')

    expect(result.outcome).toBe(SelfTestOutcome.PASSED)
    expect(result.detail).toBe('Connected on port 5084.')
  })

  it('is unproven when the step says so', async () => {
    const result = await step('Inventory', async () => unproven('Ran, but saw no tags.'))

    expect(result.outcome).toBe(SelfTestOutcome.INCONCLUSIVE)
    expect(result.detail).toBe('Ran, but saw no tags.')
  })

  it('fails when the step throws, and keeps the message', async () => {
    const result = await step('Connect', async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.9:5084')
    })

    expect(result.outcome).toBe(SelfTestOutcome.FAILED)
    // The message, not a stack. This is read by whoever is holding the cable.
    expect(result.detail).toBe('connect ECONNREFUSED 10.0.0.9:5084')
  })

  it('survives something that is not an Error', async () => {
    const result = await step('Connect', async () => {
      throw 'the reader hung up'
    })

    expect(result.outcome).toBe(SelfTestOutcome.FAILED)
    expect(result.detail).toBe('the reader hung up')
  })

  it('times every step, because the timings are part of the record', async () => {
    const result = await step('Connect', async () => 'done')

    expect(result.ms).toBeGreaterThanOrEqual(0)
  })
})

describe('summarise', () => {
  const passed = { name: 'a', outcome: SelfTestOutcome.PASSED, detail: '', ms: 0 }
  const failed = { name: 'b', outcome: SelfTestOutcome.FAILED, detail: '', ms: 0 }
  const unclear = { name: 'c', outcome: SelfTestOutcome.INCONCLUSIVE, detail: '', ms: 0 }

  it('passes only when every step passed', () => {
    expect(summarise([passed, passed])).toBe(SelfTestOutcome.PASSED)
  })

  it('is unproven when any step proved nothing', () => {
    expect(summarise([passed, unclear])).toBe(SelfTestOutcome.INCONCLUSIVE)
  })

  it('fails when any step failed, even alongside an unproven one', () => {
    // A failure is the more urgent answer and must not be softened by being
    // reported next to something merely unproven.
    expect(summarise([passed, unclear, failed])).toBe(SelfTestOutcome.FAILED)
  })

  it('treats no steps at all as unproven, not as a pass', () => {
    // A report with nothing in it has demonstrated nothing. Defaulting that to
    // PASSED would make an empty connector look verified.
    expect(summarise([])).not.toBe(SelfTestOutcome.PASSED)
  })
})
