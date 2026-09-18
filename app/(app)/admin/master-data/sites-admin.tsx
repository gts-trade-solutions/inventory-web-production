'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { Loader2, Plus, RotateCcw, XCircle } from 'lucide-react'
import { createSiteAction, updateSiteAction, type MasterDataState } from './actions'
import { Notice, latest } from './notice'
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

export interface SiteRow {
  id: string
  code: string
  name: string
  active: boolean
  locationCount: number
  stockedPlaces: number
}

export function SitesAdmin({ sites }: { sites: SiteRow[] }) {
  const [createState, create] = useActionState<MasterDataState, FormData>(createSiteAction, {})
  const [updateState, update] = useActionState<MasterDataState, FormData>(updateSiteAction, {})

  return (
    <section className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Sites</CardTitle>
          <CardDescription>
            A site is a physical warehouse. Locations, movements, counts and devices all belong to
            one, and so does each person&rsquo;s access.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={create} className="flex flex-wrap items-end gap-3">
            <div className="w-40 space-y-1.5">
              <Label htmlFor="site-code">Code</Label>
              <Input
                id="site-code"
                name="code"
                required
                placeholder="WH2"
                className="tabular uppercase"
                maxLength={16}
              />
            </div>

            <div className="min-w-48 flex-1 space-y-1.5">
              <Label htmlFor="site-name">Name</Label>
              <Input
                id="site-name"
                name="name"
                required
                placeholder="Second warehouse"
                maxLength={120}
              />
            </div>

            <AddButton />
          </form>
        </CardContent>
      </Card>

      <Notice state={latest(createState, updateState)} />

      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="text-right">Locations</TableHead>
              <TableHead className="text-right">Holding stock</TableHead>
              <TableHead className="w-36 text-right">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sites.map((site) => (
              <TableRow key={site.id} className={cn(!site.active && 'opacity-50')}>
                <TableCell className="tabular font-medium">{site.code}</TableCell>
                <TableCell>
                  {site.name}
                  {!site.active && (
                    <Badge variant="outline" className="ml-2">
                      Inactive
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="tabular text-right text-muted-foreground">
                  {site.locationCount || '—'}
                </TableCell>
                <TableCell className="tabular text-right text-muted-foreground">
                  {site.stockedPlaces || '—'}
                </TableCell>
                <TableCell className="text-right">
                  <form action={update} className="inline">
                    <input type="hidden" name="id" value={site.id} />
                    <input type="hidden" name="active" value={String(!site.active)} />
                    <ToggleButton active={site.active} stocked={site.stockedPlaces > 0} />
                  </form>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
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

function ToggleButton({ active, stocked }: { active: boolean; stocked: boolean }) {
  const { pending } = useFormStatus()

  return (
    <Button
      type="submit"
      size="sm"
      variant={active ? 'ghost' : 'outline'}
      disabled={pending}
      // Not disabled when the site holds stock, deliberately. The refusal comes
      // from the server with a sentence explaining why, which teaches more than
      // a greyed-out button that explains nothing.
      title={
        active
          ? stocked
            ? 'This site still holds stock; deactivating it will be refused'
            : 'Hide from the pickers; history is kept'
          : 'Make it usable again'
      }
    >
      {pending ? <Loader2 className="animate-spin" /> : active ? <XCircle /> : <RotateCcw />}
      {active ? 'Deactivate' : 'Reactivate'}
    </Button>
  )
}
