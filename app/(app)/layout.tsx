import { requireUser } from '@/lib/auth/guards'
import { ModeBanner } from '@/components/app-shell/mode-banner'
import { Sidebar } from '@/components/app-shell/sidebar'
import { UserMenu } from '@/components/app-shell/user-menu'
import { Toaster } from '@/components/ui/sonner'

/**
 * The authenticated console shell.
 *
 * `requireUser()` runs on every request through this layout, so no page beneath
 * it can render without a session. Middleware gates the route before this point;
 * this is the second check, because a layout that trusts middleware alone breaks
 * the moment a route is excluded from the matcher.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser()

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <ModeBanner mode={user.mode} />

      <div className="flex min-h-0 flex-1">
        {/* Tablet and up. A drawer for phone widths arrives with the scan screen,
            which is the first thing anyone will use on a small device. */}
        <div className="hidden md:block">
          <Sidebar role={user.role} />
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b bg-card px-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">Main warehouse</p>
              <p className="truncate text-xs text-muted-foreground">WH1</p>
            </div>

            <UserMenu name={user.name} email={user.email} role={user.role} />
          </header>

          <main className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
        </div>
      </div>

      <Toaster />
    </div>
  )
}
