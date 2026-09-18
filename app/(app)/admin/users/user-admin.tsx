'use client'

import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { AlertCircle, CheckCircle2, KeyRound, Loader2, UserPlus } from 'lucide-react'
import {
  createUserAction,
  resetPasswordAction,
  updateUserAction,
  type UserFormState,
} from './actions'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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

/** Mirrors the Prisma enum; a client component may not import its values. */
type Role = 'ADMIN' | 'SUPERVISOR' | 'USER'

interface Row {
  id: string
  email: string
  name: string
  role: Role
  active: boolean
  siteCodes: string[]
  lastLoginAt: string | null
}

const ROLE_LABEL: Record<Role, string> = {
  ADMIN: 'Administrator',
  SUPERVISOR: 'Supervisor',
  USER: 'Operator',
}

export function UserAdmin({
  users,
  sites,
  currentUserId,
}: {
  users: Row[]
  sites: Array<{ id: string; label: string }>
  currentUserId: string
}) {
  const [createState, createAction] = useActionState<UserFormState, FormData>(createUserAction, {})
  const [updateState, updateActionFn] = useActionState<UserFormState, FormData>(
    updateUserAction,
    {},
  )
  const [resetState, resetAction] = useActionState<UserFormState, FormData>(
    resetPasswordAction,
    {},
  )
  const [adding, setAdding] = useState(false)

  // Whichever action last produced one. Rendered in a single place so a
  // password cannot linger on screen under a later, unrelated message.
  const handover = [createState, resetState].find((state) => state.password)

  return (
    <div className="space-y-6">
      {handover?.password && (
        <Alert>
          <KeyRound className="size-4" />
          <AlertDescription>
            <p className="font-medium">
              Password for {handover.passwordFor} — shown once, and not recoverable.
            </p>
            <p className="tabular mt-2 select-all rounded-md bg-muted px-3 py-2 text-base">
              {handover.password}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Hand it over directly and ask them to change it. There is no email service yet, so
              nothing has been sent.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {[createState, updateState, resetState].map((state, index) =>
        state.error ? (
          <Alert key={index} variant="destructive">
            <AlertCircle className="size-4" />
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null,
      )}

      {updateState.message && (
        <Alert>
          <CheckCircle2 className="size-4 text-ok" />
          <AlertDescription>{updateState.message}</AlertDescription>
        </Alert>
      )}

      {adding ? (
        <Card>
          <CardHeader>
            <CardTitle>Add someone</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={createAction} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="name">Name</Label>
                  <Input id="name" name="name" required />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" name="email" type="email" required />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="role">Role</Label>
                  <select
                    id="role"
                    name="role"
                    defaultValue="USER"
                    className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="USER">Operator — day-to-day floor work</option>
                    <option value="SUPERVISOR">Supervisor — approves counts, overrides FEFO</option>
                    <option value="ADMIN">Administrator — everything, including this screen</option>
                  </select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="siteIds">Sites</Label>
                  <select
                    id="siteIds"
                    name="siteIds"
                    multiple
                    size={Math.min(sites.length, 4)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  >
                    {sites.map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <SubmitButton label="Create account" busy="Creating…" />
                <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : (
        <Button type="button" variant="outline" onClick={() => setAdding(true)}>
          <UserPlus className="mr-2 size-4" />
          Add someone
        </Button>
      )}

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Sites</TableHead>
              <TableHead>Last signed in</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((row) => (
              <TableRow key={row.id} className={row.active ? undefined : 'opacity-60'}>
                <TableCell>
                  <span className="font-medium">{row.name}</span>
                  <span className="block text-xs text-muted-foreground">{row.email}</span>
                </TableCell>

                <TableCell>
                  <form action={updateActionFn} className="flex items-center gap-2">
                    <input type="hidden" name="userId" value={row.id} />
                    <select
                      name="role"
                      defaultValue={row.role}
                      className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                      // Changing your own role away from administrator is
                      // refused by the server; disabling it here saves the
                      // round trip and explains itself.
                      disabled={row.id === currentUserId}
                    >
                      {(['USER', 'SUPERVISOR', 'ADMIN'] as Role[]).map((role) => (
                        <option key={role} value={role}>
                          {ROLE_LABEL[role]}
                        </option>
                      ))}
                    </select>
                    {row.id !== currentUserId && <RoleSubmit />}
                  </form>
                </TableCell>

                <TableCell className="tabular text-sm">
                  {row.siteCodes.length > 0 ? row.siteCodes.join(', ') : '—'}
                </TableCell>

                <TableCell className="text-sm text-muted-foreground">
                  {row.lastLoginAt ? row.lastLoginAt.slice(0, 10) : 'never'}
                </TableCell>

                <TableCell>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {!row.active && <Badge variant="secondary">Deactivated</Badge>}

                    <form action={resetAction}>
                      <input type="hidden" name="userId" value={row.id} />
                      <Button type="submit" variant="ghost" size="sm">
                        Reset password
                      </Button>
                    </form>

                    {row.id !== currentUserId && (
                      <form action={updateActionFn}>
                        <input type="hidden" name="userId" value={row.id} />
                        <input type="hidden" name="active" value={row.active ? 'false' : 'true'} />
                        <Button type="submit" variant="ghost" size="sm">
                          {row.active ? 'Deactivate' : 'Reactivate'}
                        </Button>
                      </form>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <p className="text-sm text-muted-foreground">
        Accounts are deactivated, never deleted. They own movements, counts they approved and audit
        entries, and the ledger&rsquo;s value comes from being able to say who did what.
      </p>
    </div>
  )
}

function SubmitButton({ label, busy }: { label: string; busy: string }) {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" disabled={pending}>
      {pending ? (
        <>
          <Loader2 className="mr-2 size-4 animate-spin" />
          {busy}
        </>
      ) : (
        label
      )}
    </Button>
  )
}

function RoleSubmit() {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" variant="ghost" size="sm" disabled={pending}>
      {pending ? <Loader2 className="size-4 animate-spin" /> : 'Save'}
    </Button>
  )
}
