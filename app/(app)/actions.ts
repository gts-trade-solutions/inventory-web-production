'use server'

import { redirect } from 'next/navigation'
import { signOut } from '@/auth'

export async function signOutAction() {
  // redirect: false so the redirect below runs in this action's context, rather
  // than Auth.js throwing its own mid-form-submission.
  await signOut({ redirect: false })
  redirect('/login')
}
