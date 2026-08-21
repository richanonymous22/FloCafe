'use client';

/**
 * Plemmo application shell — "Serva" style.
 *
 * A 264px white sidebar: brand lockup, a global search field, grouped nav with
 * an orange-tint active pill, and a user-profile card in the footer. All role
 * and business-type visibility rules are preserved from the original shell.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutGrid, ShoppingCart, Store, Boxes, Truck, ArrowLeftRight, MapPin,
  ClipboardList, Package, Users, UserCog, Settings, LogOut, PanelLeft,
  ChefHat, LifeBuoy, Scale, Wifi, WifiOff, Search, ChevronsUpDown, BarChart3,
  type LucideIcon,
} from 'lucide-react';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore } from '@/store/pos-settings';
import { getLandingPage } from '@/components/layout/AuthGuard';
import api from '@/lib/api';
import { useI18n } from '@/hooks/useI18n';
import { useConfirm } from '@/hooks/use-confirm';
import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent,
  SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton,
  SidebarMenuItem, SidebarRail, useSidebar,
} from '@/components/ui/sidebar';

interface NavItem {
  href: string; labelKey: string; icon: LucideIcon;
  roles: string[]; businessTypes: string[] | null; external?: boolean;
}
interface NavGroup { labelKey: string; items: NavItem[]; }

const NAV_GROUPS: NavGroup[] = [
  {
    labelKey: 'nav.group.sell',
    items: [
      { href: '/pos', labelKey: 'nav.pos', icon: ShoppingCart, roles: ['owner', 'manager', 'cashier'], businessTypes: ['restaurant'], external: true },
      { href: '/retail', labelKey: 'nav.retail', icon: Store, roles: ['owner', 'manager', 'cashier'], businessTypes: ['retail'], external: true },
      { href: '/orders', labelKey: 'nav.orders', icon: ClipboardList, roles: ['owner', 'manager', 'cashier'], businessTypes: null },
    ],
  },
  {
    labelKey: 'nav.group.operations',
    items: [
      { href: '/tables', labelKey: 'nav.tables', icon: LayoutGrid, roles: ['owner', 'manager'], businessTypes: ['restaurant'] },
      { href: '/settings?tab=kds', labelKey: 'nav.kds', icon: ChefHat, roles: ['owner', 'manager'], businessTypes: ['restaurant'], external: true },
      { href: '/products', labelKey: 'nav.products.catalogue', icon: Package, roles: ['owner', 'manager'], businessTypes: null },
      { href: '/inventory', labelKey: 'nav.inventory', icon: Boxes, roles: ['owner', 'manager'], businessTypes: null },
      { href: '/transfers', labelKey: 'nav.transfers', icon: ArrowLeftRight, roles: ['owner', 'manager'], businessTypes: null },
      { href: '/purchasing', labelKey: 'nav.purchasing', icon: Truck, roles: ['owner', 'manager'], businessTypes: null },
      { href: '/suppliers', labelKey: 'nav.suppliers', icon: Truck, roles: ['owner', 'manager'], businessTypes: null },
      { href: '/reconciliation', labelKey: 'nav.reconciliation', icon: Scale, roles: ['owner', 'manager'], businessTypes: null },
    ],
  },
  {
    labelKey: 'nav.group.insights',
    items: [
      { href: '/dashboard', labelKey: 'nav.dashboard', icon: LayoutGrid, roles: ['owner'], businessTypes: null },
      { href: '/reports', labelKey: 'nav.reports', icon: BarChart3, roles: ['owner', 'manager'], businessTypes: null },
    ],
  },
  {
    labelKey: 'nav.group.people',
    items: [
      { href: '/customers', labelKey: 'nav.customers', icon: Users, roles: ['owner', 'manager'], businessTypes: null },
      { href: '/staff', labelKey: 'nav.staff', icon: UserCog, roles: ['owner', 'manager'], businessTypes: null },
    ],
  },
  {
    labelKey: 'nav.group.business',
    items: [
      { href: '/locations', labelKey: 'nav.locations', icon: MapPin, roles: ['owner'], businessTypes: null },
      { href: '/settings', labelKey: 'nav.settings', icon: Settings, roles: ['owner', 'manager'], businessTypes: null },
    ],
  },
];

function initials(text: string) {
  return text.split(' ').map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

export default function AppSidebar() {
  const pathname = usePathname();
  const { user, currentTenant, logout } = useAuthStore();
  const { tablesRequired, kdsEnabled, setTablesRequired, setKdsEnabled } = usePosSettingsStore();
  const { isMobile, setOpenMobile, toggleSidebar } = useSidebar();
  const { t } = useI18n();
  const { confirm, ConfirmDialog } = useConfirm();
  const [emailNeedsAttention, setEmailNeedsAttention] = useState(false);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const closeMobile = () => { if (isMobile) setOpenMobile(false); };

  const role = currentTenant?.role || 'cashier';
  const businessType = currentTenant?.business_type || 'restaurant';

  const isVisible = (item: NavItem) => {
    if (item.href === '/tables' && !tablesRequired) return false;
    if (item.href === '/settings?tab=kds' && !kdsEnabled) return false;
    return item.roles.includes(role) && (item.businessTypes === null || item.businessTypes.includes(businessType));
  };
  const groups = NAV_GROUPS
    .map((g) => ({ ...g, items: g.items.filter(isVisible) }))
    .filter((g) => g.items.length > 0);
  const homeHref = getLandingPage();

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  useEffect(() => {
    if (!currentTenant) return;
    api.get('/settings/business')
      .then((res) => setTablesRequired(typeof res.data.tables_required === 'boolean' ? res.data.tables_required : true))
      .catch(() => {});
    api.get('/settings/kds_enabled')
      .then((res) => setKdsEnabled(res.data.setting?.value !== 'false'))
      .catch(() => {});
  }, [currentTenant, setTablesRequired, setKdsEnabled]);

  useEffect(() => {
    if (role !== 'owner') return;
    let active = true;
    const refresh = async () => {
      try {
        const [acc, cloud] = await Promise.all([api.get('/settings/cloud/account'), api.get('/settings/cloud')]);
        if (!active) return;
        const deletion = acc.data?.deletion_request?.status || cloud.data?.cloud_deletion_status;
        setEmailNeedsAttention(
          (acc.data?.cloud_account_available !== false && Boolean(acc.data?.email) && !acc.data?.verified)
          || ['pending', 'processing', 'failed'].includes(deletion)
        );
      } catch { if (active) setEmailNeedsAttention(false); }
    };
    void refresh();
    window.addEventListener('flo:cloud-account-status-changed', refresh);
    return () => { active = false; window.removeEventListener('flo:cloud-account-status-changed', refresh); };
  }, [role]);

  const businessName = currentTenant?.business_name || t('common.brandName');
  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);
  const userName = user?.name || user?.email || t('nav.user', { defaultValue: 'User' });

  return (
    <Sidebar collapsible="icon" className="border-sidebar-border">
      <SidebarHeader className="gap-3 px-3 pt-4 pb-2">
        <Link href={homeHref} className="flex items-center gap-2.5 px-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
          <div className="flex aspect-square size-9 shrink-0 items-center justify-center rounded-xl bg-primary text-base font-bold text-primary-foreground shadow-sm">P</div>
          <div className="flex flex-col leading-tight group-data-[collapsible=icon]:hidden">
            <span className="text-[15px] font-bold text-foreground">Plemmo</span>
            <span className="text-[10px] font-semibold uppercase tracking-widest text-text-subtle">POS System</span>
          </div>
        </Link>

        <div className="relative group-data-[collapsible=icon]:hidden">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-subtle" />
          <input
            readOnly
            placeholder={t('nav.searchPlaceholder', { defaultValue: 'Search menu, orders, staff' })}
            className="h-9 w-full rounded-lg border border-transparent bg-muted pl-9 pr-3 text-sm text-foreground placeholder:text-text-subtle outline-none transition-colors focus:border-input focus:bg-surface"
          />
        </div>
      </SidebarHeader>

      <SidebarContent className="px-1">
        {groups.map((group) => (
          <SidebarGroup key={group.labelKey} className="py-1">
            <SidebarGroupLabel className="px-3 text-[10px] font-bold uppercase tracking-widest text-text-subtle group-data-[collapsible=icon]:hidden">
              {t(group.labelKey)}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                {group.items.map((item) => {
                  const [hrefPath, hrefQuery] = item.href.split('?');
                  const isActive = !hrefQuery && (pathname === hrefPath || pathname?.startsWith(hrefPath + '/'));
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild isActive={isActive} tooltip={t(item.labelKey)}
                        className="h-10 gap-3 rounded-lg px-3 font-medium data-[active=true]:bg-sidebar-accent data-[active=true]:font-semibold data-[active=true]:text-sidebar-accent-foreground"
                      >
                        <Link href={item.href} onClick={closeMobile}>
                          <item.icon className="size-[18px] shrink-0" />
                          <span className="flex-1">{t(item.labelKey)}</span>
                          {item.href === '/settings' && emailNeedsAttention && (
                            <span aria-label="Attention" className="size-2 rounded-full bg-destructive" />
                          )}
                          {item.external && (
                            <span aria-hidden className="text-text-subtle group-data-[collapsible=icon]:hidden">↗</span>
                          )}
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="gap-2 p-2">
        {/* Connectivity card */}
        <div className="flex items-center gap-2 rounded-xl border border-hairline bg-surface px-3 py-2.5 group-data-[collapsible=icon]:hidden">
          <span className={cn('flex size-7 items-center justify-center rounded-lg', online ? 'bg-success-tint text-success' : 'bg-danger-tint text-destructive')}>
            {online ? <Wifi className="size-4" /> : <WifiOff className="size-4" />}
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <p className="text-xs font-semibold text-foreground">{online ? t('nav.context.online') : t('nav.context.offline')}</p>
            <p className="truncate text-[11px] text-text-subtle">{t('common.brandName')}</p>
          </div>
          <Link href="/support" onClick={closeMobile} title={t('nav.support')} className="text-text-subtle transition-colors hover:text-foreground">
            <LifeBuoy className="size-4" />
          </Link>
        </div>

        {/* Profile card */}
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-hover group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
                  <Avatar className="size-8 rounded-lg">
                    <AvatarFallback className="rounded-lg bg-primary/10 text-xs font-bold text-primary">{initials(userName)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:hidden">
                    <p className="truncate text-sm font-semibold text-foreground">{userName}</p>
                    <p className="truncate text-xs text-text-subtle">{roleLabel} · {businessName}</p>
                  </div>
                  <ChevronsUpDown className="size-4 shrink-0 text-text-subtle group-data-[collapsible=icon]:hidden" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top" className="w-56">
                <DropdownMenuItem onClick={toggleSidebar}>
                  <PanelLeft className="size-4" /> {t('nav.collapse')}
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/support" onClick={closeMobile}><LifeBuoy className="size-4" /> {t('nav.support')}</Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={async () => { if (await confirm(t('nav.confirmLogout', { defaultValue: 'Are you sure you want to log out?' }))) logout(); }}
                >
                  <LogOut className="size-4" /> {t('nav.logout')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
      {ConfirmDialog}
    </Sidebar>
  );
}
