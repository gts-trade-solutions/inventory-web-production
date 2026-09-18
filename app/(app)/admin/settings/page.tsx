import type { Metadata } from 'next'
import { UserRole } from '@prisma/client'
import { requireRole } from '@/lib/auth/guards'
import { listSettings } from '@/lib/services/settings'
import { PageHeader } from '@/components/page-header'
import { SettingsForm } from './settings-form'

export const metadata: Metadata = { title: 'Settings' }

/**
 * Operating policy.
 *
 * Everything here changes behaviour. That is the entry requirement for the
 * registry behind it: a settings screen full of switches that do nothing is
 * worse than no settings screen, because somebody will set one and believe it
 * took effect.
 *
 * Global values for now. The store is already per-site with a global fallback,
 * so a site picker is a screen change rather than a data change when a second
 * warehouse arrives.
 */
export default async function SettingsPage() {
  const user = await requireRole(UserRole.ADMIN)
  const settings = await listSettings(user.db)

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Settings"
        description="Policy the system enforces: what it blocks, what it caps, and what it will post without a supervisor."
      />

      <div className="space-y-4">
        {settings.map((setting) => (
          <SettingsForm
            key={setting.key}
            siteId=""
            setting={{
              key: setting.key,
              label: setting.label,
              help: setting.help,
              options: setting.options,
              // Empty means "use the default", which is how the form reads an
              // absent limit too.
              value: setting.value === null || setting.value === undefined ? '' : String(setting.value),
              isDefault: setting.isDefault,
            }}
          />
        ))}
      </div>

      <p className="text-sm text-muted-foreground">
        Changes take effect on the next movement, and every one is recorded in the audit log.
      </p>
    </div>
  )
}
