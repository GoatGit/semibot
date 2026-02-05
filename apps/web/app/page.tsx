import { AppShell } from '@/components/layout/AppShell'
import { NavBar } from '@/components/layout/NavBar'
import { Sidebar } from '@/components/layout/Sidebar'
import { DetailCanvas } from '@/components/layout/DetailCanvas'

export default function HomePage() {
  return (
    <AppShell>
      <NavBar />
      <Sidebar />
      <DetailCanvas />
    </AppShell>
  )
}
