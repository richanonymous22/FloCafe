'use client';

import { usePathname } from 'next/navigation';
import AppSidebar from '@/components/layout/Sidebar';
import AuthGuard from '@/components/layout/AuthGuard';
import Topbar from '@/components/layout/Topbar';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import StatusBar from '@/components/layout/StatusBar';
import GlobalNotifications from '@/components/layout/GlobalNotifications';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Full-height, non-scrolling till/operational surfaces run edge-to-edge and
  // manage their own chrome (no back-office topbar).
  const isPos = pathname === '/pos' || pathname === '/kds' || pathname === '/retail';

  return (
    <AuthGuard>
      <SidebarProvider defaultOpen>
        <AppSidebar />
        <SidebarInset className="h-screen overflow-hidden flex flex-col bg-background">
          {!isPos && <Topbar />}
          {!isPos && <GlobalNotifications />}
          <div className={isPos
            ? 'flex-1 min-h-0 flex flex-col overflow-hidden p-4'
            : 'flex-1 overflow-auto min-w-0 p-4 md:p-6'
          }>
            {children}
          </div>
          <StatusBar />
        </SidebarInset>
      </SidebarProvider>
    </AuthGuard>
  );
}
