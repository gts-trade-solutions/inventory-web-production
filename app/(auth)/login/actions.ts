'use server'

import { AuthError } from 'next-auth'
import { redirect } from 'next/navigation'
import { signIn } from '@/auth'
import { isDemoModeEnabled, parseMode } from '@/lib/mode'

export interface LoginState {
  error?: string
}

/**
 * Signs in and lands on the dashboard.
 *
 * `mode` comes from the form, but is never trusted as given: it is narrowed by
 * `parseMode` and then baked into the signed session by the Credentials
 * provider. From that point on the session decides which database this user
 * talks to, and nothing on the client can change it (WADR-024).
 */
export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  const mode = parseMode(formData.get('mode'))

  if (!email || !password) {
    return { error: 'Enter your email and password.' }
  }

  if (mode === 'DEMO' && !isDemoModeEnabled()) {
    return { error: 'Demo mode is not enabled on this deployment.' }
  }

  try {
    await signIn('credentials', { email, password, mode, redirect: false })
  } catch (error) {
    if (error instanceof AuthError) {
      // Deliberately the same message whether the address is unknown or the
      // password is wrong — anything more specific enumerates accounts.
      return { error: 'That email and password do not match an active account.' }
    }
    throw error
  }

  // Outside the try: redirect() throws a control-flow signal that the catch
  // above would otherwise swallow.
  redirect('/dashboard')
}
