import { UserRole } from '@prisma/client'
import {
  Boxes,
  ClipboardCheck,
  Cpu,
  FileWarning,
  FolderTree,
  LayoutDashboard,
  MapPin,
  Package,
  Printer,
  ScanLine,
  ScrollText,
  SlidersHorizontal,
  Tags,
  Upload,
  Users,
  Settings,
  Smartphone,
  Layers,
  ArrowLeftRight,
  BarChart3,
  type LucideIcon,
} from 'lucide-react'

/**
 * The console's navigation, mirroring the structure in ARCHITECTURE §3.
 *
 * `minimumRole` controls VISIBILITY only. Hiding a link is presentation; the
 * enforcement is `requireRole()` on the server, and every destination below
 * repeats the check for itself (ARCHITECTURE §6).
 */

export interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  minimumRole?: UserRole
  /** Phases that have not landed yet are shown greyed rather than hidden, so the
   *  shape of the finished product is visible while it is being built. */
  comingSoon?: boolean
  /** Shown only in Demo mode. A 'switch the network off' button on a live
   *  warehouse screen is an invitation to a confusing afternoon. */
  demoOnly?: boolean
}

export interface NavSection {
  title: string
  items: NavItem[]
}

export const NAV_SECTIONS: NavSection[] = [
  {
    title: 'Operations',
    items: [
      { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/scan', label: 'Scan', icon: ScanLine },
      { href: '/inventory', label: 'Inventory', icon: Package },
      { href: '/movements', label: 'Movements', icon: ArrowLeftRight },
      { href: '/counts', label: 'Cycle counts', icon: ClipboardCheck },
    ],
  },
  {
    title: 'Traceability',
    items: [
      { href: '/batches', label: 'Batches & expiry', icon: Layers },
      { href: '/serials', label: 'Serial units', icon: Boxes },
      { href: '/locations', label: 'Locations', icon: MapPin, comingSoon: true },
    ],
  },
  {
    title: 'Devices',
    items: [
      { href: '/devices', label: 'Devices', icon: Cpu },
      { href: '/labels', label: 'Labels & printing', icon: Printer },
      { href: '/demo/handset', label: 'Simulated handset', icon: Smartphone, demoOnly: true },
    ],
  },
  {
    title: 'Oversight',
    items: [
      {
        href: '/exceptions',
        label: 'Exceptions',
        icon: FileWarning,
        minimumRole: UserRole.SUPERVISOR,
      },
      { href: '/reports', label: 'Reports', icon: BarChart3, comingSoon: true },
      {
        href: '/admin/users',
        label: 'People',
        icon: Users,
        minimumRole: UserRole.ADMIN,
      },
      {
        href: '/admin/master-data',
        label: 'Master data',
        icon: FolderTree,
        minimumRole: UserRole.ADMIN,
      },
      {
        href: '/admin/reason-codes',
        label: 'Reason codes',
        icon: Settings,
        minimumRole: UserRole.ADMIN,
      },
      {
        href: '/admin/import',
        label: 'Import',
        icon: Upload,
        minimumRole: UserRole.ADMIN,
      },
      {
        href: '/admin/labels',
        label: 'Label templates',
        icon: Tags,
        minimumRole: UserRole.ADMIN,
      },
      {
        href: '/admin/settings',
        label: 'Settings',
        icon: SlidersHorizontal,
        minimumRole: UserRole.ADMIN,
      },
      {
        href: '/admin/audit',
        label: 'Audit log',
        icon: ScrollText,
        minimumRole: UserRole.ADMIN,
      },
    ],
  },
]
