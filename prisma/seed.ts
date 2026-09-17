import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { PrismaClient, ReasonScope, UserRole } from '@prisma/client'
import bcrypt from 'bcryptjs'

/**
 * Bootstrap seed: the minimum a fresh database needs to be usable.
 *
 * One site, one admin, and the reason codes that ADJUST and SCRAP require
 * (WADR-022). This is NOT the demo dataset — that is 50 SKUs with batches,
 * serials and planted count variances, and it lands in Phase 6 as seed-demo.ts.
 *
 * Idempotent: safe to re-run. It upserts rather than inserting, so it never
 * duplicates and never clobbers an edited row's id.
 *
 * Usage:
 *   npm run db:seed                                   (live)
 *   DATABASE_URL="$DATABASE_URL_DEMO" npm run db:seed (demo)
 */

const prisma = new PrismaClient()

const BOOTSTRAP_EMAIL = process.env.BOOTSTRAP_ADMIN_EMAIL ?? 'admin@inventory.local'
const BOOTSTRAP_PASSWORD = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? 'admin12345'

const REASON_CODES: Array<{
  code: string
  label: string
  appliesTo: ReasonScope
  requiresNote: boolean
}> = [
  {
    code: 'COUNT_VAR',
    label: 'Cycle count variance',
    appliesTo: ReasonScope.ADJUST,
    requiresNote: false,
  },
  {
    code: 'DAMAGE',
    label: 'Damaged in handling',
    appliesTo: ReasonScope.ADJUST,
    requiresNote: true,
  },
  {
    code: 'FOUND',
    label: 'Found unrecorded stock',
    appliesTo: ReasonScope.ADJUST,
    requiresNote: true,
  },
  { code: 'DATA_FIX', label: 'Data correction', appliesTo: ReasonScope.ADJUST, requiresNote: true },
  { code: 'EXPIRED', label: 'Past expiry date', appliesTo: ReasonScope.SCRAP, requiresNote: false },
  { code: 'BROKEN', label: 'Broken or unusable', appliesTo: ReasonScope.SCRAP, requiresNote: true },
  {
    code: 'QUALITY',
    label: 'Failed quality check',
    appliesTo: ReasonScope.QUARANTINE,
    requiresNote: true,
  },
  {
    code: 'RECALL',
    label: 'Supplier recall',
    appliesTo: ReasonScope.QUARANTINE,
    requiresNote: true,
  },
]

const SETTINGS: Array<{ key: string; value: unknown }> = [
  // Expired stock cannot be issued. 'WARN' allows it with a supervisor override.
  { key: 'expiry.issuePolicy', value: 'BLOCK' },
  // Propose the earliest-expiring batch on issue.
  { key: 'allocation.fefo', value: true },
  // A USER may adjust by at most this many units; beyond it needs a SUPERVISOR.
  { key: 'adjust.userLimit', value: 100 },
  // null disables auto-approval of counts; a number is a variance threshold.
  { key: 'count.autoApproveThreshold', value: null },
]

async function main() {
  const target = new URL(process.env.DATABASE_URL ?? '').pathname.replace('/', '')
  console.log(`Seeding "${target}" …`)

  const site = await prisma.site.upsert({
    where: { code: 'WH1' },
    update: {},
    create: { id: randomUUID(), code: 'WH1', name: 'Main warehouse' },
  })
  console.log(`  site       ${site.code} — ${site.name}`)

  for (const reason of REASON_CODES) {
    await prisma.reasonCode.upsert({
      where: { code: reason.code },
      update: {
        label: reason.label,
        appliesTo: reason.appliesTo,
        requiresNote: reason.requiresNote,
      },
      create: { id: randomUUID(), ...reason },
    })
  }
  console.log(`  reasons    ${REASON_CODES.length} codes`)

  for (const setting of SETTINGS) {
    await prisma.setting.upsert({
      where: { key_siteId: { key: setting.key, siteId: '' } },
      update: {},
      create: { key: setting.key, siteId: '', value: setting.value as never },
    })
  }
  console.log(`  settings   ${SETTINGS.length} defaults`)

  const passwordHash = await bcrypt.hash(BOOTSTRAP_PASSWORD, 12)
  const admin = await prisma.user.upsert({
    where: { email: BOOTSTRAP_EMAIL },
    // Do not reset the password of an existing admin on re-seed.
    update: { role: UserRole.ADMIN, active: true, deletedAt: null },
    create: {
      id: randomUUID(),
      email: BOOTSTRAP_EMAIL,
      name: 'Administrator',
      passwordHash,
      role: UserRole.ADMIN,
      defaultSiteId: site.id,
    },
  })

  await prisma.userSite.upsert({
    where: { userId_siteId: { userId: admin.id, siteId: site.id } },
    update: {},
    create: { userId: admin.id, siteId: site.id },
  })
  console.log(`  admin      ${admin.email}`)

  console.log('\nDone.')
  console.log(`Sign in with ${BOOTSTRAP_EMAIL} / ${BOOTSTRAP_PASSWORD}`)
  console.log('CHANGE THIS PASSWORD before the system holds anything real.\n')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
