'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, FlaskConical, Loader2, Warehouse } from 'lucide-react'
import { login, type LoginState } from './actions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

const DEMO_CREDENTIALS = { email: 'admin@inventory.local', password: 'admin12345' }

export function LoginForm({ demoAvailable }: { demoAvailable: boolean }) {
  const [state, formAction] = useActionState<LoginState, FormData>(login, {})
  const [mode, setMode] = useState<'LIVE' | 'DEMO'>('LIVE')

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="mode" value={mode} />

      {demoAvailable && <ModeToggle mode={mode} onChange={setMode} />}

      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          defaultValue={mode === 'DEMO' ? DEMO_CREDENTIALS.email : undefined}
          key={`email-${mode}`}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          defaultValue={mode === 'DEMO' ? DEMO_CREDENTIALS.password : undefined}
          key={`password-${mode}`}
        />
      </div>

      {state.error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <SubmitButton mode={mode} />

      {mode === 'DEMO' && (
        <p className="text-center text-xs text-muted-foreground">
          Demo credentials are filled in. This signs you into a separate database with simulated
          devices — nothing you do here touches real stock.
        </p>
      )}
    </form>
  )
}

/**
 * Mode is chosen at sign-in rather than toggled later, because the session
 * carries it. Switching means signing in again, which is precisely what stops a
 * demo session from ever writing live stock.
 */
function ModeToggle({
  mode,
  onChange,
}: {
  mode: 'LIVE' | 'DEMO'
  onChange: (mode: 'LIVE' | 'DEMO') => void
}) {
  return (
    <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-1">
      {(
        [
          { value: 'LIVE', label: 'Live', icon: Warehouse, hint: 'Real stock' },
          { value: 'DEMO', label: 'Demo', icon: FlaskConical, hint: 'Sample data' },
        ] as const
      ).map((option) => {
        const Icon = option.icon
        const selected = mode === option.value
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={selected}
            className={cn(
              'flex flex-col items-center gap-0.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              selected
                ? option.value === 'DEMO'
                  ? 'bg-demo text-demo-foreground shadow-sm'
                  : 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <span className="flex items-center gap-1.5">
              <Icon className="size-4" />
              {option.label}
            </span>
            <span className="text-[11px] font-normal opacity-80">{option.hint}</span>
          </button>
        )
      })}
    </div>
  )
}

function SubmitButton({ mode }: { mode: 'LIVE' | 'DEMO' }) {
  const { pending } = useFormStatus()

  return (
    <Button
      type="submit"
      size="lg"
      disabled={pending}
      className={cn('w-full', mode === 'DEMO' && 'bg-demo text-demo-foreground hover:bg-demo/90')}
    >
      {pending && <Loader2 className="animate-spin" />}
      {pending ? 'Signing in…' : mode === 'DEMO' ? 'Enter demo' : 'Sign in'}
    </Button>
  )
}
