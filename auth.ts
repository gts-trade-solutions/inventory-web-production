import NextAuth from 'next-auth'
import Credentials from 'next-auth/providers/credentials'
import { z } from 'zod'
import { authConfig } from '@/auth.config'
import { dbFor, isDemoModeEnabled, parseMode } from '@/lib/mode'
import { fakeVerify, verifyPassword } from '@/lib/auth/password'

/**
 * Web session authentication.
 *
 * The mobile app does NOT use this — it exchanges credentials for a device-bound
 * JWT at /api/v1/auth/token, because an offline phone cannot round-trip a cookie
 * session and a lost device must be revocable without disabling its user
 * (ARCHITECTURE §6). Both paths share this user table and password hashing.
 *
 * `mode` is part of sign-in, not a later toggle: the user picks LIVE or DEMO at
 * the login screen, the choice is baked into the signed session, and switching
 * means signing in again. That is what makes it impossible for a demo session to
 * write live stock (WADR-024).
 */

const credentialsSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
  mode: z.string().optional(),
})

export const { handlers, signIn, signOut, auth } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
        mode: { label: 'Mode', type: 'text' },
      },

      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw)
        if (!parsed.success) return null

        const { email, password } = parsed.data
        const mode = parseMode(parsed.data.mode)

        // parseMode already downgrades DEMO to LIVE when demo mode is switched
        // off, but refuse outright rather than silently signing someone into the
        // live database when they asked for the demo one.
        if (parsed.data.mode === 'DEMO' && !isDemoModeEnabled()) return null

        const db = dbFor(mode)

        const user = await db.user.findUnique({
          where: { email: email.toLowerCase() },
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            active: true,
            deletedAt: true,
            passwordHash: true,
            defaultSiteId: true,
            sites: { select: { siteId: true } },
          },
        })

        // Always spend the same time whether or not the address exists, so the
        // response cannot be used to enumerate accounts.
        if (!user) {
          await fakeVerify(password)
          return null
        }

        const passwordValid = await verifyPassword(password, user.passwordHash)
        if (!passwordValid) return null
        if (!user.active || user.deletedAt) return null

        await db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          siteIds: user.sites.map((s) => s.siteId),
          defaultSiteId: user.defaultSiteId,
          mode,
        }
      },
    }),
  ],
})
