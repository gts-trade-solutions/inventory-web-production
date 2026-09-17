/**
 * The demo accounts, defined once.
 *
 * Both `prisma/seed-demo.ts` and the login screen import this. They used to hold
 * their own copies, which drifted the moment the seed's password changed: the
 * login page went on prefilling credentials that no longer existed, and the only
 * symptom was "that email and password do not match an active account" on the
 * one screen meant to be frictionless.
 *
 * Deliberately free of server-only imports, so the login form can use it
 * directly (scripts/check-client-boundaries.mjs enforces that).
 *
 * These are DEMO credentials for a throwaway database that is wiped on every
 * reseed. They are printed on the login screen on purpose. Nothing here is a
 * secret, and nothing here can reach the live database — a demo session is bound
 * to the demo database by the signed session (WADR-024).
 */

export type DemoRole = 'ADMIN' | 'SUPERVISOR' | 'USER'

export interface DemoAccount {
  email: string
  name: string
  role: DemoRole
  password: string
  /** What this account is for, shown on the login screen. */
  blurb: string
}

export const DEMO_PASSWORD = 'demo1234'

export const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    email: 'admin@inventory.local',
    name: 'Priya Admin',
    role: 'ADMIN',
    password: DEMO_PASSWORD,
    blurb: 'Everything, including master data and settings',
  },
  {
    email: 'supervisor@inventory.local',
    name: 'Ravi Supervisor',
    role: 'SUPERVISOR',
    password: DEMO_PASSWORD,
    blurb: 'Approves counts, quarantines batches, overrides FEFO',
  },
  {
    email: 'operator@inventory.local',
    name: 'Asha Operator',
    role: 'USER',
    password: DEMO_PASSWORD,
    blurb: 'Day-to-day floor operations',
  },
]

/** The account the login screen prefills. */
export const DEFAULT_DEMO_ACCOUNT = DEMO_ACCOUNTS[0]!
