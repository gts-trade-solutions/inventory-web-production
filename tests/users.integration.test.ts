import { randomUUID } from 'node:crypto'
import { UserRole } from '@prisma/client'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createUser, listUsers, resetPassword, updateUser } from '@/lib/services/users'
import { verifyPassword } from '@/lib/auth/password'
import { prisma, seedWarehouse, type Warehouse } from './helpers/warehouse'

/**
 * User administration.
 *
 * The tests that matter most are the ones about locking yourself out. An
 * administrator who demotes the last administrator has broken the system in a
 * way that needs a developer with database access to fix — which is the exact
 * dependency this phase exists to remove.
 */

let wh: Warehouse
let adminId: string

beforeEach(async () => {
  wh = await seedWarehouse()
  await prisma.refreshToken.deleteMany()
  await prisma.userSite.deleteMany()
  await prisma.user.deleteMany({ where: { email: { not: 'tester@inventory.local' } } })

  // The seeded tester is an ADMIN; make it the one under test.
  adminId = wh.userId
})

afterAll(async () => {
  await prisma.$disconnect()
})

const admin = () => ({ userId: adminId })

describe('creating an account', () => {
  it('creates one with a password shown once', async () => {
    const { user, temporaryPassword } = await createUser(prisma, {
      email: 'New.Person@Inventory.local',
      name: 'New Person',
      role: UserRole.USER,
      siteIds: [wh.siteId],
    })

    expect(user.role).toBe(UserRole.USER)
    expect(user.siteCodes).toEqual(['TEST'])
    expect(temporaryPassword.length).toBeGreaterThan(12)
  })

  it('normalises the address, so a capital letter is not a second account', async () => {
    await createUser(prisma, {
      email: 'Person@Inventory.Local',
      name: 'Person',
      role: UserRole.USER,
      siteIds: [],
    })

    const stored = await prisma.user.findUnique({ where: { email: 'person@inventory.local' } })
    expect(stored).not.toBeNull()
  })

  it('stores only the hash, never the password', async () => {
    const { user, temporaryPassword } = await createUser(prisma, {
      email: 'hashed@inventory.local',
      name: 'Hashed',
      role: UserRole.USER,
      siteIds: [],
    })

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })

    expect(stored.passwordHash).not.toBe(temporaryPassword)
    expect(await verifyPassword(temporaryPassword, stored.passwordHash)).toBe(true)
  })

  it('refuses a duplicate address', async () => {
    await createUser(prisma, {
      email: 'twice@inventory.local',
      name: 'First',
      role: UserRole.USER,
      siteIds: [],
    })

    await expect(
      createUser(prisma, {
        email: 'twice@inventory.local',
        name: 'Second',
        role: UserRole.USER,
        siteIds: [],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('gives every account a different password', async () => {
    const first = await createUser(prisma, {
      email: 'a@inventory.local',
      name: 'A',
      role: UserRole.USER,
      siteIds: [],
    })
    const second = await createUser(prisma, {
      email: 'b@inventory.local',
      name: 'B',
      role: UserRole.USER,
      siteIds: [],
    })

    expect(first.temporaryPassword).not.toBe(second.temporaryPassword)
  })
})

describe('not locking everybody out', () => {
  it('refuses to deactivate the last administrator', async () => {
    // One click away from a system nobody can administer, recoverable only by a
    // developer with database access.
    const other = await createUser(prisma, {
      email: 'operator@inventory.local',
      name: 'Operator',
      role: UserRole.USER,
      siteIds: [],
    })

    await expect(
      updateUser(prisma, adminId, { active: false }, { userId: other.user.id }),
    ).rejects.toThrow(/only active administrator/i)
  })

  it('refuses to demote the last administrator', async () => {
    const other = await createUser(prisma, {
      email: 'operator@inventory.local',
      name: 'Operator',
      role: UserRole.USER,
      siteIds: [],
    })

    await expect(
      updateUser(prisma, adminId, { role: UserRole.USER }, { userId: other.user.id }),
    ).rejects.toThrow(/only active administrator/i)
  })

  it('allows it once there is a second administrator', async () => {
    const second = await createUser(prisma, {
      email: 'second.admin@inventory.local',
      name: 'Second Admin',
      role: UserRole.ADMIN,
      siteIds: [],
    })

    const updated = await updateUser(prisma, adminId, { active: false }, { userId: second.user.id })

    expect(updated.active).toBe(false)
  })

  it('will not let you deactivate yourself', async () => {
    // Even with another admin available: it is always a mistake, and the screen
    // lists your own name beside everyone else's.
    await createUser(prisma, {
      email: 'second.admin@inventory.local',
      name: 'Second',
      role: UserRole.ADMIN,
      siteIds: [],
    })

    await expect(updateUser(prisma, adminId, { active: false }, admin())).rejects.toThrow(
      /your own account/i,
    )
  })

  it('will not let you remove your own administrator access', async () => {
    await createUser(prisma, {
      email: 'second.admin@inventory.local',
      name: 'Second',
      role: UserRole.ADMIN,
      siteIds: [],
    })

    await expect(
      updateUser(prisma, adminId, { role: UserRole.SUPERVISOR }, admin()),
    ).rejects.toThrow(/your own administrator access/i)
  })
})

describe('changing an account', () => {
  it('replaces the site list rather than adding to it', async () => {
    // Upserted: sites are not wiped between runs, so a create would fail the
    // second time this suite is run against the same database.
    const other = await prisma.site.upsert({
      where: { code: 'WH2' },
      update: {},
      create: { id: randomUUID(), code: 'WH2', name: 'Second warehouse' },
    })
    const { user } = await createUser(prisma, {
      email: 'moves@inventory.local',
      name: 'Moves',
      role: UserRole.USER,
      siteIds: [wh.siteId],
    })

    const updated = await updateUser(prisma, user.id, { siteIds: [other.id] }, admin())

    expect(updated.siteCodes).toEqual(['WH2'])
  })

  it('ends every live session when an account is deactivated', async () => {
    // A refresh token outliving the change would leave somebody working with
    // access they no longer have, for up to thirty days.
    const { user } = await createUser(prisma, {
      email: 'leaver@inventory.local',
      name: 'Leaver',
      role: UserRole.USER,
      siteIds: [],
    })
    await prisma.refreshToken.create({
      data: {
        id: randomUUID(),
        tokenHash: 'a'.repeat(64),
        userId: user.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    })

    await updateUser(prisma, user.id, { active: false }, admin())

    const live = await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } })
    expect(live).toBe(0)
  })

  it('ends live sessions when the role changes', async () => {
    const { user } = await createUser(prisma, {
      email: 'promoted@inventory.local',
      name: 'Promoted',
      role: UserRole.USER,
      siteIds: [],
    })
    await prisma.refreshToken.create({
      data: {
        id: randomUUID(),
        tokenHash: 'b'.repeat(64),
        userId: user.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    })

    await updateUser(prisma, user.id, { role: UserRole.SUPERVISOR }, admin())

    expect(await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } })).toBe(0)
  })

  it('refuses an account that does not exist', async () => {
    await expect(
      updateUser(prisma, randomUUID(), { name: 'Nobody' }, admin()),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('resetting a password', () => {
  it('sets a new one and hands it back once', async () => {
    const { user } = await createUser(prisma, {
      email: 'forgot@inventory.local',
      name: 'Forgot',
      role: UserRole.USER,
      siteIds: [],
    })

    const { temporaryPassword } = await resetPassword(prisma, user.id)
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } })

    expect(await verifyPassword(temporaryPassword, stored.passwordHash)).toBe(true)
  })

  it('invalidates the old password', async () => {
    const created = await createUser(prisma, {
      email: 'rotates@inventory.local',
      name: 'Rotates',
      role: UserRole.USER,
      siteIds: [],
    })

    await resetPassword(prisma, created.user.id)
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: created.user.id } })

    expect(await verifyPassword(created.temporaryPassword, stored.passwordHash)).toBe(false)
  })

  it('ends every live session', async () => {
    // The old password is gone, so the sessions it authorised must go too.
    const { user } = await createUser(prisma, {
      email: 'sessions@inventory.local',
      name: 'Sessions',
      role: UserRole.USER,
      siteIds: [],
    })
    await prisma.refreshToken.create({
      data: {
        id: randomUUID(),
        tokenHash: 'c'.repeat(64),
        userId: user.id,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    })

    await resetPassword(prisma, user.id)

    expect(await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } })).toBe(0)
  })
})

describe('listing', () => {
  it('puts active accounts first', async () => {
    const { user } = await createUser(prisma, {
      email: 'retired@inventory.local',
      name: 'AAA Retired',
      role: UserRole.USER,
      siteIds: [],
    })
    await createUser(prisma, {
      email: 'second.admin@inventory.local',
      name: 'Second',
      role: UserRole.ADMIN,
      siteIds: [],
    })
    await updateUser(prisma, user.id, { active: false }, admin())

    const users = await listUsers(prisma)

    // Alphabetically first, but inactive — so it must not lead the list.
    expect(users[users.length - 1]?.name).toBe('AAA Retired')
  })
})
