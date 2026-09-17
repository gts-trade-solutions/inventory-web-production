import 'server-only'
import bcrypt from 'bcryptjs'

/**
 * Password hashing.
 *
 * Cost 12 is roughly 250ms on current hardware — slow enough to make offline
 * cracking expensive, fast enough that an operator signing in at the start of a
 * shift does not notice.
 */
const BCRYPT_COST = 12

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST)
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash)
}

/**
 * A bcrypt hash of a value nobody knows, compared against when the email does
 * not exist. Without it, a missing user returns in ~1ms and a real one in
 * ~250ms, which tells an attacker which addresses are registered.
 */
const TIMING_DECOY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.7PjsUyfPHbfuu6Vh8rFL6Jbe5Qs/Jhq'

/** Burns the same time as a real verification, then fails. */
export async function fakeVerify(plain: string): Promise<false> {
  await bcrypt.compare(plain, TIMING_DECOY_HASH)
  return false
}
