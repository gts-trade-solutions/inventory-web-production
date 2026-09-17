'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, CheckCircle2, Loader2, Plus, RotateCcw, XCircle } from 'lucide-react'
import { createReasonCodeAction, toggleReasonCodeAction, type ReasonCodeState } from './actions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

type ReasonScope = 'ADJUST' | 'SCRAP' | 'COUNT' | 'QUARANTINE'

export interface ReasonCodeRow {
  id: string
  code: string
  label: string
  appliesTo: ReasonScope
  requiresNote: boolean
  active: boolean
  usageCount: number
}

const SCOPES: Array<{ value: ReasonScope; label: string; blurb: string }> = [
  { value: 'ADJUST', label: 'Adjustment', blurb: 'Correcting a quantity' },
  { value: 'SCRAP', label: 'Scrap', blurb: 'Writing stock off' },
  { value: 'QUARANTINE', label: 'Quarantine', blurb: 'Freezing a batch' },
  { value: 'COUNT', label: 'Count', blurb: 'Posted by an approved count' },
]

export function ReasonCodeAdmin({ codes }: { codes: ReasonCodeRow[] }) {
  const [createState, create] = useActionState<ReasonCodeState, FormData>(
    createReasonCodeAction,
    {},
  )
  const [toggleState, toggle] = useActionState<ReasonCodeState, FormData>(
    toggleReasonCodeAction,
    {},
  )

  const notice = createState.message || createState.error ? createState : toggleState

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Add a reason</CardTitle>
          <CardDescription>
            Operators pick from this list, so the label should be what they would say out loud.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={create} className="flex flex-wrap items-end gap-3">
            <div className="w-40 space-y-1.5">
              <Label htmlFor="code">Code</Label>
              <Input
                id="code"
                name="code"
                required
                placeholder="WATER_DAMAGE"
                className="tabular uppercase"
                maxLength={32}
              />
            </div>

            <div className="min-w-48 flex-1 space-y-1.5">
              <Label htmlFor="label">Label</Label>
              <Input id="label" name="label" required placeholder="Water damage" maxLength={120} />
            </div>

            <div className="w-44 space-y-1.5">
              <Label htmlFor="appliesTo">Applies to</Label>
              <select
                id="appliesTo"
                name="appliesTo"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-base"
              >
                {SCOPES.map((scope) => (
                  <option key={scope.value} value={scope.value}>
                    {scope.label}
                  </option>
                ))}
              </select>
            </div>

            <label className="flex h-10 items-center gap-2 text-sm">
              <input type="checkbox" name="requiresNote" className="size-4" />
              Needs a note
            </label>

            <AddButton />
          </form>
        </CardContent>
      </Card>

      {notice.error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{notice.error}</AlertDescription>
        </Alert>
      )}
      {notice.message && (
        <Alert>
          <CheckCircle2 className="text-ok" />
          <AlertDescription>{notice.message}</AlertDescription>
        </Alert>
      )}

      {SCOPES.map((scope) => {
        const inScope = codes.filter((code) => code.appliesTo === scope.value)
        if (inScope.length === 0) return null

        return (
          <div key={scope.value}>
            <h2 className="mb-2 text-sm font-medium">
              {scope.label}
              <span className="ml-2 font-normal text-muted-foreground">{scope.blurb}</span>
            </h2>

            <div className="rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Label</TableHead>
                    <TableHead className="text-right">Used</TableHead>
                    <TableHead className="w-32 text-right">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {inScope.map((code) => (
                    <TableRow key={code.id} className={cn(!code.active && 'opacity-50')}>
                      <TableCell className="tabular font-medium">{code.code}</TableCell>
                      <TableCell>
                        {code.label}
                        {code.requiresNote && (
                          <Badge variant="outline" className="ml-2">
                            Note required
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="tabular text-right text-muted-foreground">
                        {code.usageCount > 0 ? code.usageCount : '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        <form action={toggle} className="inline">
                          <input type="hidden" name="id" value={code.id} />
                          <input type="hidden" name="active" value={String(!code.active)} />
                          <ToggleButton active={code.active} />
                        </form>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function AddButton() {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" disabled={pending}>
      {pending ? <Loader2 className="animate-spin" /> : <Plus />}
      Add
    </Button>
  )
}

function ToggleButton({ active }: { active: boolean }) {
  const { pending } = useFormStatus()

  return (
    <Button
      type="submit"
      size="sm"
      variant={active ? 'ghost' : 'outline'}
      disabled={pending}
      // Retire, never delete: movements reference these, and the ledger is
      // append-only.
      title={active ? 'Hide from the pickers; history is kept' : 'Show in the pickers again'}
    >
      {pending ? <Loader2 className="animate-spin" /> : active ? <XCircle /> : <RotateCcw />}
      {active ? 'Retire' : 'Restore'}
    </Button>
  )
}
