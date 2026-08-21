'use client';

/**
 * Plemmo application shell — grouped, context-aware navigation.
 *
 * Replaces the previous flat single-list nav (preserved as Sidebar.legacy.tsx)
 * with sectioned groups — Sell, Operations, Insights, People, Business — plus a
 * business/role context header and an online/offline indicator. All role and
 * business-type visibility rules from the legacy shell are preserved verbatim;
 * only the organisation and chrome changed. A group renders only when it has at
 * least one item the current user may see.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  ShoppingCart,
  Store,
  Boxes,
  Truck,
  ArrowLeftRight,
  MapPin,
  ClipboardList,
  Package,
  Users,
  UserCog,
  Settings,
  LogOut,
  PanelLeft,
  ChefHat,
  UserCircle,
  LifeBuoy,
  Scale,
  Wifi,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore } from '@/store/pos-settings';
import { getLandingPage } from '@/components/layout/AuthGuard';
import api from '@/lib/api';
import { useI18n } from '@/hooks/useI18n';
import { useConfirm } from '@/hooks/use-confirm';
import { cn } from '@/lib/utils';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar';

interface NavItem {
  href: string;
  labelKey: string;
  icon: LucideIcon;
  roles: string[];
  businessTypes: string[] | null; // null = all business types
}

interface NavGroup {
  labelKey: string;
  items: NavItem[];
}

// Grouped Plemmo navigation. Roles/businessTypes carry the same rules the
// legacy flat list enforced — nothing is newly exposed or hidden.
const NAV_GROUPS: NavGroup[] = [
  {
    labelKey: 'nav.group.sell',
    items: [
      { href: '/pos', labelKey: 'nav.pos', icon: ShoppingCart, roles: ['owner', 'manager', 'cashier'], businessTypes: null },
      { href: '/retail', labelKey: 'nav.retail', icon: Store, roles: ['owner', 'manager', 'cashier'], businessTypes: null },
      { href: '/orders', labelKey: 'nav.orders', icon: ClipboardList, roles: ['owner', 'manager', 'cashier'], businessTypes: null },
    ],
  },
  {
    labelKey: 'nav.group.operations',
    items: [
      { href: '/tables', labelKey: 'nav.tables', icon: LayoutDashboard, roles: ['owner', 'manager'], businessTypes: ['restaurant'] },
      { href: '/settings?tab=kds', labelKey: 'nav.kds', icon: ChefHat, roles: ['owner', 'manager'], businessTypes: ['restaurant'] },
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
      { href: '/dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard, roles: ['owner'], businessTypes: null },
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

export default function AppSidebar() {
  const pathname = usePathname();
  const { user, currentTenant, logout } = useAuthStore();
  const { tablesRequired, kdsEnabled, setTablesRequired, setKdsEnabled } = usePosSettingsStore();
  const { isMobile, setOpenMobile, toggleSidebar } = useSidebar();
  const { t } = useI18n();
  const { confirm, ConfirmDialog } = useConfirm();
  const [emailNeedsAttention, setEmailNeedsAttention] = useState(false);
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  );
  const closeMobile = () => { if (isMobile) setOpenMobile(false); };

  const role = currentTenant?.role || 'cashier';
  const businessType = currentTenant?.business_type || 'restaurant';

  const isVisible = (item: NavItem) => {
    if (item.href === '/tables' && !tablesRequired) return false;
    // KDS disabled → hide the nav entry entirely (issue #133).
    if (item.href === '/settings?tab=kds' && !kdsEnabled) return false;
    return item.roles.includes(role)
      && (item.businessTypes === null || item.businessTypes.includes(businessType));
  };

  const groups = NAV_GROUPS
    .map((group) => ({ ...group, items: group.items.filter(isVisible) }))
    .filter((group) => group.items.length > 0);

  const homeHref = getLandingPage();

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  useEffect(() => {
    if (!currentTenant) return;
    api.get('/settings/business')
      .then((res) => {
        setTablesRequired(typeof res.data.tables_required === 'boolean' ? res.data.tables_required : true);
      })
      .catch(() => { });
    api.get('/settings/kds_enabled')
      .then((res) => setKdsEnabled(res.data.setting?.value !== 'false'))
      .catch(() => { });
  }, [currentTenant, setTablesRequired, setKdsEnabled]);

  useEffect(() => {
    if (role !== 'owner') return;
    let active = true;
    const refreshCloudAttention = async () => {
      try {
        const [accountResponse, cloudResponse] = await Promise.all([
          api.get('/settings/cloud/account'),
          api.get('/settings/cloud'),
        ]);
        if (!active) return;
        const deletionStatus = accountResponse.data?.deletion_request?.status || cloudResponse.data?.cloud_deletion_status;
        setEmailNeedsAttention(
          (accountResponse.data?.cloud_account_available !== false && Boolean(accountResponse.data?.email) && !accountResponse.data?.verified)
          || ['pending', 'processing', 'failed'].includes(deletionStatus)
        );
      } catch {
        if (active) setEmailNeedsAttention(false);
      }
    };
    void refreshCloudAttention();
    window.addEventListener('flo:cloud-account-status-changed', refreshCloudAttention);
    return () => {
      active = false;
      window.removeEventListener('flo:cloud-account-status-changed', refreshCloudAttention);
    };
  }, [role]);

  const businessName = currentTenant?.business_name || t('common.brandName');
  const roleLabel = role.charAt(0).toUpperCase() + role.slice(1);

  return (
    <Sidebar collapsible="icon" className="border-sidebar-border">
      <SidebarHeader className="gap-3 px-3 pt-4 pb-2 group-data-[collapsible=icon]:px-2">
        {/* Plemmo wordmark — the editorial signature in the display serif. */}
        <Link
          href={homeHref}
          className="flex items-center gap-2.5 group-data-[collapsible=icon]:justify-center"
        >
          <div className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground shadow-sm">
            P
          </div>
          <span className="text-display text-xl text-foreground group-data-[collapsible=icon]:hidden">
            Plemmo
          </span>
        </Link>

        {/* Business + role + connectivity. Hidden in icon-collapsed mode. */}
        <div className="min-w-0 space-y-2 group-data-[collapsible=icon]:hidden">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground">{businessName}</p>
            <p className="truncate text-xs text-muted-foreground">{roleLabel}</p>
          </div>
          <div
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium',
              online
                ? 'bg-success-tint text-success'
                : 'bg-danger-tint text-destructive'
            )}
            title={online ? t('nav.context.online') : t('nav.context.offline')}
          >
            {online ? <Wifi className="size-3" /> : <WifiOff className="size-3" />}
            <span>{online ? t('nav.context.online') : t('nav.context.offline')}</span>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent>
        {groups.map((group) => (
          <SidebarGroup key={group.labelKey}>
            <SidebarGroupLabel className="eyebrow px-3 group-data-[collapsible=icon]:hidden">
              {t(group.labelKey)}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const [hrefPath, hrefQuery] = item.href.split('?');
                  const isActive = !hrefQuery && (pathname === hrefPath || pathname?.startsWith(hrefPath + '/'));
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild isActive={isActive} tooltip={t(item.labelKey)}>
                        <Link href={item.href} onClick={closeMobile}>
                          <span className="relative flex size-4 shrink-0 items-center justify-center">
                            <item.icon className="size-4 shrink-0" />
                            {item.href === '/settings' && emailNeedsAttention && (
                              <span aria-label="Email verification required" className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-red-500 ring-2 ring-sidebar" />
                            )}
                          </span>
                          <span>{t(item.labelKey)}</span>
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

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild isActive={pathname === '/support'} tooltip={t('nav.support')}>
              <Link href="/support" onClick={closeMobile}>
                <LifeBuoy />
                <span>{t('nav.support')}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={toggleSidebar} tooltip={t('nav.toggleSidebar')}>
              <PanelLeft />
              <span>{t('nav.collapse')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            {/* Identity label, not a button — nothing to click through to, so it
                deliberately skips SidebarMenuButton's interactive/hover styling. */}
            <div
              title={user?.name || user?.email || t('nav.user', { defaultValue: 'User' })}
              className="flex w-full items-center gap-2 rounded-md p-2 text-left text-sm text-sidebar-foreground/70 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0"
            >
              <UserCircle />
              <span className="truncate">{user?.name || user?.email || t('nav.user', { defaultValue: 'User' })}</span>
            </div>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={async () => { if (await confirm(t('nav.confirmLogout', { defaultValue: 'Are you sure you want to log out?' }))) logout(); }} tooltip={t('nav.logoutTooltip')}>
              <LogOut />
              <span>{t('nav.logout')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
      {ConfirmDialog}
    </Sidebar>
  );
}
