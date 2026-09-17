import { redirect } from 'next/navigation'

export default function RootPage() {
  // The console lives under (app); auth and the mode banner are applied there.
  redirect('/dashboard')
}
