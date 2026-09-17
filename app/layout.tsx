import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: {
    default: 'Inventory',
    template: '%s · Inventory',
  },
  description: 'Warehouse inventory management with Zebra device integration.',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Warehouse tablets are used at arm's length; let people zoom.
  maximumScale: 5,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  )
}
