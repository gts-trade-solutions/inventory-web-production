'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { Loader2, Plus, RotateCcw, Trash2, XCircle } from 'lucide-react'
import {
  createCategoryAction,
  deleteCategoryAction,
  updateCategoryAction,
  type MasterDataState,
} from './actions'
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

export interface CategoryRow {
  id: string
  name: string
  parentId: string | null
  active: boolean
  itemCount: number
  depth: number
}

export function CategoriesAdmin({ categories }: { categories: CategoryRow[] }) {
  const [createState, create] = useActionState<MasterDataState, FormData>(createCategoryAction, {})
  const [updateState, update] = useActionState<MasterDataState, FormData>(updateCategoryAction, {})
  const [deleteState, remove] = useActionState<MasterDataState, FormData>(deleteCategoryAction, {})

  return (
    <section className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Categories</CardTitle>
          <CardDescription>
            How stock is grouped in the filters and reports. Categories can nest — a sub-category
            belongs to the one above it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={create} className="flex flex-wrap items-end gap-3">
            <div className="min-w-48 flex-1 space-y-1.5">
              <Label htmlFor="category-name">Name</Label>
              <Input
                id="category-name"
                name="name"
                required
                placeholder="Consumables"
                maxLength={120}
              />
            </div>

            <div className="w-56 space-y-1.5">
              <Label htmlFor="category-parent">Inside</Label>
              <select
                id="category-parent"
                name="parentId"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-base"
              >
                <option value="">Top level</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {'— '.repeat(category.depth)}
                    {category.name}
                  </option>
                ))}
              </select>
            </div>

            <AddButton />
          </form>
        </CardContent>
      </Card>

      <Notice state={latest(createState, updateState, deleteState)} />

      {categories.length === 0 ? (
        <p className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
          No categories yet. Items without one still work — a category is for grouping, not for
          tracking.
        </p>
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead className="text-right">Items</TableHead>
                <TableHead className="w-56 text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {categories.map((category) => (
                <TableRow key={category.id} className={cn(!category.active && 'opacity-50')}>
                  <TableCell>
                    {/* Indented rather than nested markup: a table row cannot
                        contain another table, and the depth is what makes the
                        tree readable at a glance. */}
                    <span
                      style={{ paddingLeft: `${category.depth * 1.25}rem` }}
                      className="inline-block"
                    >
                      {category.depth > 0 && (
                        <span className="mr-1.5 text-muted-foreground">└</span>
                      )}
                      {category.name}
                    </span>
                    {!category.active && (
                      <Badge variant="outline" className="ml-2">
                        Inactive
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="tabular text-right text-muted-foreground">
                    {category.itemCount || '—'}
                  </TableCell>
                  <TableCell className="space-x-1 text-right">
                    <form action={update} className="inline">
                      <input type="hidden" name="id" value={category.id} />
                      <input type="hidden" name="active" value={String(!category.active)} />
                      <ToggleButton active={category.active} />
                    </form>

                    <form action={remove} className="inline">
                      <input type="hidden" name="id" value={category.id} />
                      <RemoveButton inUse={category.itemCount > 0} />
                    </form>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
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

function ToggleButton({ active }: { active: boolean }) {
  const { pending } = useFormStatus()

  return (
    <Button
      type="submit"
      size="sm"
      variant="ghost"
      disabled={pending}
      title={active ? 'Hide from the pickers; items keep it' : 'Show in the pickers again'}
    >
      {pending ? <Loader2 className="animate-spin" /> : active ? <XCircle /> : <RotateCcw />}
      {active ? 'Deactivate' : 'Reactivate'}
    </Button>
  )
}

function RemoveButton({ inUse }: { inUse: boolean }) {
  const { pending } = useFormStatus()

  return (
    <Button
      type="submit"
      size="sm"
      variant="ghost"
      disabled={pending}
      title={
        inUse ? 'This category still has items; removing it will be refused' : 'Remove it entirely'
      }
    >
      {pending ? <Loader2 className="animate-spin" /> : <Trash2 />}
      <span className="sr-only">Remove</span>
    </Button>
  )
}
