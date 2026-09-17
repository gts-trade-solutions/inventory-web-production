import { UserRole } from '@prisma/client'
import {
  Boxes,
  ClipboardCheck,
  Cpu,
  FileWarning,
  LayoutDashboard,
  MapPin,
  Package,
  Printer,
  ScanLine,
  Settings,
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
      { href: '/scan', label: 'Scan', icon: ScanLine, comingSoon: true },
      { href: '/inventory', label: 'Inventory', icon: Package, comingSoon: true },
      { href: '/movements', label: 'Movements', icon: ArrowLeftRight, comingSoon: true },
      { href: '/counts', label: 'Cycle counts', icon: ClipboardCheck, comingSoon: true },
    ],
  },
  {
    title: 'Traceability',
    items: [
      { href: '/batches', label: 'Batches & expiry', icon: Layers, comingSoon: true },
      { href: '/serials', label: 'Serial units', icon: Boxes, comingSoon: true },
      { href: '/locations', label: 'Locations', icon: MapPin, comingSoon: true },
    ],
  },
  {
    title: 'Devices',
    items: [
      { href: '/devices', label: 'Devices', icon: Cpu, comingSoon: true },
      { href: '/labels', label: 'Labels & printing', icon: Printer, comingSoon: true },
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
        comingSoon: true,
      },
      { href: '/reports', label: 'Reports', icon: BarChart3, comingSoon: true },
      {
        href: '/admin',
        label: 'Administration',
        icon: Settings,
        minimumRole: UserRole.ADMIN,
        comingSoon: true,
      },
    ],
  },
]
