import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Boxes } from 'lucide-react'
import { LoginForm } from './login-form'
import { currentUser } from '@/lib/auth/guards'
import { isDemoModeEnabled } from '@/lib/mode'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export const metadata: Metadata = { title: 'Sign in' }

export default async function LoginPage() {
  if (await currentUser()) redirect('/dashboard')

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Boxes className="size-6" />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Inventory</h1>
        </div>

        <Card>
          <CardHeader className="pb-4">
            <CardTitle>Sign in</CardTitle>
            <CardDescription>Use your warehouse account.</CardDescription>
          </CardHeader>
          <CardContent>
            <LoginForm demoAvailable={isDemoModeEnabled()} />
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
