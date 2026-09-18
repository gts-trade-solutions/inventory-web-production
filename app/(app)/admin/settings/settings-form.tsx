'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
import { saveSettingAction, type SettingsState } from './actions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export interface SettingView {
  key: string
  label: string
  help: string
  options?: ReadonlyArray<{ value: string; label: string }>
  value: string
  isDefault: boolean
}

/**
 * One form per setting.
 *
 * Separate forms rather than one big Save: each of these changes what the
 * system refuses to do, and a single button that commits four policy changes at
 * once makes it much easier to change one by accident.
 */
export function SettingsForm({ setting, siteId }: { setting: SettingView; siteId: string }) {
  const [state, formAction] = useActionState<SettingsState, FormData>(saveSettingAction, {})

  return (
    <form action={formAction} className="space-y-2 rounded-lg border bg-card p-4">
      <input type="hidden" name="key" value={setting.key} />
      <input type="hidden" name="siteId" value={siteId} />

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={setting.key} className="font-medium">
          {setting.label}
        </label>
        {setting.isDefault && <Badge variant="outline">Default</Badge>}
      </div>

      <p className="text-sm text-muted-foreground">{setting.help}</p>

      <div className="flex flex-wrap items-center gap-2">
        {setting.options ? (
          <select
            id={setting.key}
            name="value"
            defaultValue={setting.value}
            className="h-11 min-w-64 rounded-md border border-input bg-background px-3 text-sm"
          >
            {setting.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <Input
            id={setting.key}
            name="value"
            defaultValue={setting.value}
            placeholder="No limit"
            className="max-w-48"
            inputMode="numeric"
          />
        )}

        <SaveButton />
      </div>

      {state.error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      {state.message && (
        <Alert>
          <CheckCircle2 className="size-4 text-ok" />
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}
    </form>
  )
}

function SaveButton() {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" variant="outline" disabled={pending}>
      {pending ? <Loader2 className="size-4 animate-spin" /> : 'Save'}
    </Button>
  )
}
