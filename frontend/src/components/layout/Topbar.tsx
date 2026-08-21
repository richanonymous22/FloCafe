'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Search, Bell, Plus, ChevronDown } from 'lucide-react';
import { useAuthStore } from '@/store/auth';
import { useI18n } from '@/hooks/useI18n';
import { Button } from '@/components/ui/button';
import { SidebarTrigger } from '@/components/ui/sidebar';

// Route → page-title translation key (falls back to a humanised segment).
const TITLE_KEYS: Record<string, string> = {
  '/dashboard': 'nav.dashboard',
  '/orders': 'nav.orders',
  '/products': 'nav.products.catalogue',
  '/inventory': 'nav.inventory',
  '/transfers': 'nav.transfers',
  '/purchasing': 'nav.purchasing',
  '/suppliers': 'nav.suppliers',
  '/reconciliation': 'nav.reconciliation',
  '/customers': 'nav.customers',
  '/staff': 'nav.staff',
  '/locations': 'nav.locations',
  '/settings': 'nav.settings',
  '/support': 'nav.support',
  '/retail': 'nav.retail',
};

function humanise(path: string) {
  const seg = path.replace(/^\//, '').split('/')[0] || 'Dashboard';
  return seg.charAt(0).toUpperCase() + seg.slice(1);
}

export default function Topbar() {
  const pathname = usePathname() || '';
  const { currentTenant } = useAuthStore();
  const { t } = useI18n();

  const key = Object.keys(TITLE_KEYS).find((p) => pathname === p || pathname.startsWith(p + '/'));
  const title = key ? t(TITLE_KEYS[key]) : humanise(pathname);
  const business = currentTenant?.business_name || t('common.brandName');

  return (
    <header className="flex h-[64px] shrink-0 items-center gap-3 border-b border-hairline bg-surface px-4 md:px-6">
      <SidebarTrigger className="md:hidden" />

      <div className="min-w-0">
        <h1 className="truncate text-lg font-bold leading-tight text-foreground">{title}</h1>
        <p className="hidden truncate text-xs text-text-subtle sm:block">{business}</p>
      </div>

      {/* Branch context (visual) */}
      <button className="ml-1 hidden items-center gap-2 rounded-lg border border-hairline bg-surface px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-hover lg:inline-flex">
        <span className="size-1.5 rounded-full bg-success" />
        {business}
        <ChevronDown className="size-4 text-text-subtle" />
      </button>

      {/* Global search */}
      <div className="relative ml-auto hidden w-full max-w-sm md:block">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-subtle" />
        <input
          readOnly
          placeholder={t('nav.searchOrdersPlaceholder', { defaultValue: 'Search orders, items or staff' })}
          className="h-10 w-full rounded-lg border border-hairline bg-surface pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-text-subtle focus:border-input"
        />
      </div>

      <button
        aria-label="Notifications"
        className="ml-auto flex size-10 items-center justify-center rounded-lg border border-hairline bg-surface text-foreground transition-colors hover:bg-hover md:ml-0"
      >
        <Bell className="size-[18px]" />
      </button>

      <Button asChild className="h-10 gap-1.5 px-4 font-semibold shadow-sm">
        <Link href="/retail">
          <Plus className="size-4" />
          <span className="hidden sm:inline">{t('nav.newSale')}</span>
        </Link>
      </Button>
    </header>
  );
}
