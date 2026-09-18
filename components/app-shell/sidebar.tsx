'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Boxes } from 'lucide-react'
import type { UserRole } from '@prisma/client'
import type { AppMode } from '@/lib/mode'
import { NAV_SECTIONS } from './navigation'
import { cn } from '@/lib/utils'

const ROLE_RANK: Record<UserRole, number> = { USER: 1, SUPERVISOR: 2, ADMIN: 3 }

export function Sidebar({
  role,
  mode,
  onNavigate,
}: {
  role: UserRole
  mode: AppMode
  onNavigate?: () => void
}) {
  const pathname = usePathname()

  return (
    <nav className="flex h-full w-64 shrink-0 flex-col border-r bg-card">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Boxes className="size-4" />
        </div>
        <span className="font-semibold tracking-tight">Inventory</span>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto p-3">
        {NAV_SECTIONS.map((section) => {
          const visible = section.items.filter(
            (item) =>
              (!item.minimumRole || ROLE_RANK[role] >= ROLE_RANK[item.minimumRole]) &&
              (!item.demoOnly || mode === 'DEMO'),
          )
          if (visible.length === 0) return null

          return (
            <div key={section.title}>
              <p className="px-3 pb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {section.title}
              </p>
              <ul className="space-y-0.5">
                {visible.map((item) => {
                  const Icon = item.icon
                  const active = pathname === item.href || pathname.startsWith(`${item.href}/`)

                  if (item.comingSoon) {
                    return (
                      <li key={item.href}>
                        <span
                          className="flex cursor-not-allowed items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground/50"
                          title="Not built yet"
                        >
                          <Icon className="size-4 shrink-0" />
                          {item.label}
                        </span>
                      </li>
                    )
                  }

                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={onNavigate}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
                          active
                            ? 'bg-primary/10 font-medium text-primary'
                            : 'text-foreground/80 hover:bg-accent hover:text-accent-foreground',
                        )}
                      >
                        <Icon className="size-4 shrink-0" />
                        {item.label}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </div>
    </nav>
  )
}
