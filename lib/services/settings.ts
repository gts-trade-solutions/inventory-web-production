import 'server-only'
import { z } from 'zod'
import type { PrismaClient } from '@prisma/client'
import type { Db } from '@/lib/db'
import { ApiError, ErrorCode } from '@/lib/api/errors'

/**
 * Operating policy, editable by an administrator.
 *
 * Every setting here CHANGES BEHAVIOUR. That is the entry requirement: a
 * settings screen full of switches that do nothing is worse than no settings
 * screen, because somebody will set one and believe it took effect. Anything
 * that is only a UI convenience does not belong in this registry.
 *
 * Values are stored per site with a global fallback, because a cold store and a
 * dry goods warehouse do not share an expiry policy. The global row is
 * `siteId: ''`.
 */

const definitions = {
  'expiry.issuePolicy': {
    schema: z.enum(['BLOCK', 'WARN']),
    fallback: 'BLOCK' as const,
    label: 'Issuing expired stock',
    help: 'BLOCK refuses it outright. WARN records the issue with a supervisor override on the movement.',
    options: [
      { value: 'BLOCK', label: 'Block it' },
      { value: 'WARN', label: 'Allow with a supervisor override' },
    ],
  },

  'count.autoApproveThreshold': {
    schema: z.number().int().min(0).nullable(),
    /**
     * Null disables auto-approval, and that is the shipped default.
     *
     * A count that posts itself is a count nobody checked. The option exists
     * because a warehouse counting thousands of lines a week will want it for
     * the trivial ones, but it has to be switched on deliberately (WADR-008).
     */
    fallback: null,
    label: 'Auto-approve counts within',
    help: 'Net units. A count whose net variance is within this posts without a supervisor. Leave empty to require approval for every count.',
  },

  'adjust.maxQuantity': {
    schema: z.number().int().min(0).nullable(),
    /**
     * A cap on a single adjustment.
     *
     * Adjustments are the one movement with no physical counterpart — nothing
     * arrived, nothing left, the number simply changed. A typo in that box is
     * the cheapest way to destroy stock accuracy, and a cap is the cheapest
     * defence.
     */
    fallback: null,
    label: 'Largest single adjustment',
    help: 'Units. An adjustment larger than this is refused. Leave empty for no limit.',
  },
} as const

export type SettingKey = keyof typeof definitions

type Value<K extends SettingKey> = z.infer<(typeof definitions)[K]['schema']>

export interface SettingDescriptor {
  key: SettingKey
  label: string
  help: string
  options?: ReadonlyArray<{ value: string; label: string }>
  value: unknown
  /** True when nothing is stored and the shipped default is in force. */
  isDefault: boolean
}

/**
 * Reads one setting, falling back from site to global to the shipped default.
 *
 * A stored value that no longer parses — an old shape, a hand-edited row — is
 * treated as absent rather than trusted. Policy that cannot be understood must
 * not be obeyed, and the safest reading of an unreadable policy is the default
 * the system shipped with.
 */
export async function getSetting<K extends SettingKey>(
  db: Db,
  key: K,
  siteId = '',
): Promise<Value<K>> {
  const rows = await db.setting.findMany({
    where: { key, siteId: { in: [siteId, ''] } },
    select: { siteId: true, value: true },
  })

  // A site row beats the global one.
  const row =
    rows.find((candidate) => candidate.siteId === siteId) ?? rows.find((c) => c.siteId === '')
  if (!row) return definitions[key].fallback as Value<K>

  const parsed = definitions[key].schema.safeParse(row.value)
  return parsed.success ? (parsed.data as Value<K>) : (definitions[key].fallback as Value<K>)
}

/** Everything an administrator can change, with what is currently in force. */
export async function listSettings(db: PrismaClient, siteId = ''): Promise<SettingDescriptor[]> {
  const stored = await db.setting.findMany({
    where: { siteId: { in: [siteId, ''] } },
    select: { key: true, siteId: true, value: true },
  })

  return (Object.keys(definitions) as SettingKey[]).map((key) => {
    const row =
      stored.find((candidate) => candidate.key === key && candidate.siteId === siteId) ??
      stored.find((candidate) => candidate.key === key && candidate.siteId === '')

    const definition = definitions[key]
    const parsed = row ? definition.schema.safeParse(row.value) : null

    return {
      key,
      label: definition.label,
      help: definition.help,
      options: 'options' in definition ? definition.options : undefined,
      value: parsed?.success ? parsed.data : definition.fallback,
      isDefault: !parsed?.success,
    }
  })
}

export async function setSetting(
  db: PrismaClient,
  key: SettingKey,
  value: unknown,
  siteId = '',
): Promise<void> {
  const definition = definitions[key]
  const parsed = definition.schema.safeParse(value)

  if (!parsed.success) {
    throw new ApiError(
      ErrorCode.VALIDATION_FAILED,
      `"${definition.label}" does not accept that value: ${parsed.error.issues[0]?.message ?? 'invalid'}.`,
      { key },
    )
  }

  await db.setting.upsert({
    where: { key_siteId: { key, siteId } },
    update: { value: parsed.data as never },
    create: { key, siteId, value: parsed.data as never },
  })
}

/** Removes an override, so the shipped default applies again. */
export async function clearSetting(db: PrismaClient, key: SettingKey, siteId = ''): Promise<void> {
  await db.setting.deleteMany({ where: { key, siteId } })
}

export function isSettingKey(value: string): value is SettingKey {
  return value in definitions
}
