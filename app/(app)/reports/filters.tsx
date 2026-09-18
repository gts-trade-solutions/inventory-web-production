import type { PrismaClient } from '@prisma/client'
import { Button } from '@/components/ui/button'

/**
 * Report filters, as a plain GET form.
 *
 * No client state: the filters live in the URL, so a filtered report can be
 * bookmarked, sent to somebody, or quoted in a message — which is what people
 * actually do with a report they want a second opinion on. Client-side filter
 * state produces a URL that always shows the unfiltered view.
 */

export interface FilterOptions {
  sites: Array<{ id: string; code: string; name: string }>
  categories: Array<{ id: string; name: string }>
}

export async function filterOptions(db: PrismaClient): Promise<FilterOptions> {
  const [sites, categories] = await Promise.all([
    db.site.findMany({
      where: { active: true, deletedAt: null },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, name: true },
    }),
    db.category.findMany({
      where: { active: true, deletedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  ])

  return { sites, categories }
}

const selectClass = 'h-10 w-full rounded-md border border-input bg-background px-3 text-base'

export function ReportFilters({
  options,
  current,
  show = { site: true, category: true, dates: false, grain: false },
}: {
  options: FilterOptions
  current: { siteId?: string; categoryId?: string; from?: string; to?: string; grain?: string }
  show?: { site?: boolean; category?: boolean; dates?: boolean; grain?: boolean }
}) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
      {show.grain && (
        <div className="w-48 space-y-1.5">
          <label htmlFor="grain" className="text-sm font-medium">
            Group by
          </label>
          <select
            id="grain"
            name="grain"
            defaultValue={current.grain ?? 'ITEM'}
            className={selectClass}
          >
            <option value="ITEM">Item</option>
            <option value="LOCATION">Item and location</option>
            <option value="BATCH">Item, location and batch</option>
          </select>
        </div>
      )}

      {show.dates && (
        <>
          <div className="w-44 space-y-1.5">
            <label htmlFor="from" className="text-sm font-medium">
              From
            </label>
            <input
              id="from"
              name="from"
              type="date"
              defaultValue={current.from}
              className={selectClass}
            />
          </div>
          <div className="w-44 space-y-1.5">
            <label htmlFor="to" className="text-sm font-medium">
              To
            </label>
            <input
              id="to"
              name="to"
              type="date"
              defaultValue={current.to}
              className={selectClass}
            />
          </div>
        </>
      )}

      {show.site && options.sites.length > 1 && (
        <div className="w-52 space-y-1.5">
          <label htmlFor="siteId" className="text-sm font-medium">
            Site
          </label>
          <select
            id="siteId"
            name="siteId"
            defaultValue={current.siteId ?? ''}
            className={selectClass}
          >
            <option value="">All sites</option>
            {options.sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.code} · {site.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {show.category && options.categories.length > 0 && (
        <div className="w-52 space-y-1.5">
          <label htmlFor="categoryId" className="text-sm font-medium">
            Category
          </label>
          <select
            id="categoryId"
            name="categoryId"
            defaultValue={current.categoryId ?? ''}
            className={selectClass}
          >
            <option value="">All categories</option>
            {options.categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <Button type="submit" variant="secondary">
        Apply
      </Button>
    </form>
  )
}
