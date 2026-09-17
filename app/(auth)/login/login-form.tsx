'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, FlaskConical, Loader2, Warehouse } from 'lucide-react'
import { login, type LoginState } from './actions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { DEFAULT_DEMO_ACCOUNT, DEMO_ACCOUNTS } from '@/lib/demo-accounts'
import { cn } from '@/lib/utils'

type Mode = 'LIVE' | 'DEMO'

export function LoginForm({ demoAvailable }: { demoAvailable: boolean }) {
  const [state, formAction] = useActionState<LoginState, FormData>(login, {})
  const [mode, setMode] = useState<Mode>('LIVE')
  const [credentials, setCredentials] = useState({ email: '', password: '' })

  /**
   * Switching to Demo prefills; switching back to Live clears.
   *
   * Leaving demo credentials in the boxes after switching back would invite
   * someone to submit them against the live database and be told, unhelpfully,
   * that they do not match an account.
   */
  const chooseMode = (next: Mode) => {
    setMode(next)
    setCredentials(
      next === 'DEMO'
        ? { email: DEFAULT_DEMO_ACCOUNT.email, password: DEFAULT_DEMO_ACCOUNT.password }
        : { email: '', password: '' },
    )
  }

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="mode" value={mode} />

      {demoAvailable && <ModeToggle mode={mode} onChange={chooseMode} />}

      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          value={credentials.email}
          onChange={(event) => setCredentials((c) => ({ ...c, email: event.target.value }))}
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
          value={credentials.password}
          onChange={(event) => setCredentials((c) => ({ ...c, password: event.target.value }))}
        />
      </div>

      {state.error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <SubmitButton mode={mode} />

      {mode === 'DEMO' && <DemoAccounts onPick={setCredentials} />}
    </form>
  )
}

/**
 * Mode is chosen at sign-in rather than toggled later, because the session
 * carries it. Switching means signing in again, which is precisely what stops a
 * demo session from ever writing live stock.
 */
function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  const options = [
    { value: 'LIVE', label: 'Live', icon: Warehouse, hint: 'Real stock' },
    { value: 'DEMO', label: 'Demo', icon: FlaskConical, hint: 'Sample data' },
  ] as const

  return (
    <div className="grid grid-cols-2 gap-2 rounded-lg border bg-muted/40 p-1">
      {options.map((option) => {
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

/**
 * The three demo roles, one click each.
 *
 * Listed in full because the point of Demo mode is to let someone see what a
 * supervisor can do that an operator cannot, without hunting for a password.
 * These guard a throwaway database that is wiped on every reseed, and they are
 * defined once in lib/demo-accounts.ts alongside the seed that creates them —
 * the previous copy here drifted from the seed and prefilled a password that no
 * longer existed.
 */
function DemoAccounts({ onPick }: { onPick: (c: { email: string; password: string }) => void }) {
  return (
    <div className="space-y-1 rounded-lg border bg-muted/30 p-3">
      <p className="pb-1 text-xs text-muted-foreground">
        Sample data and simulated devices. Nothing here touches real stock.
      </p>

      {DEMO_ACCOUNTS.map((account) => (
        <button
          key={account.email}
          type="button"
          onClick={() => onPick({ email: account.email, password: account.password })}
          className="flex w-full items-baseline justify-between gap-3 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
        >
          <span className="min-w-0">
            <span className="font-medium">{account.role}</span>
            <span className="block text-muted-foreground">{account.blurb}</span>
          </span>
          <span className="tabular shrink-0 text-muted-foreground">
            {account.email.split('@')[0]}
          </span>
        </button>
      ))}
    </div>
  )
}

function SubmitButton({ mode }: { mode: Mode }) {
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
