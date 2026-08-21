'use client';

import { useState, useEffect, useRef, Suspense, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { getLandingPage } from '@/components/layout/AuthGuard';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import toast from 'react-hot-toast';
import { useI18n } from '@/hooks/useI18n';
import { ROLE_LABEL_KEYS, BUSINESS_TYPE_LABEL_KEYS } from '@/lib/i18n-enums';
import { Eye, EyeOff } from 'lucide-react';
import { FoodSprite, FoodTile } from '@/components/brand/FoodSprite';

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login, selectTenant, user, tenants, currentTenant, loadFromStorage } = useAuthStore();
  const { t } = useI18n();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    fetch('/api/auth/setup/status')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.needsSetup) router.replace('/setup');
      })
      .catch(() => {});

    fetch('/api/health')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && data.status !== 'ok') {
          setDbError(data.db || t('auth.dbErrorPrefix'));
        }
      })
      .catch(() => {});
  }, [router, t]);

  useEffect(() => {
    loadFromStorage();
  }, [loadFromStorage]);

  const handleTenantSelect = useCallback(async (tenantId: number) => {
    setLoading(true);
    try {
      await selectTenant(tenantId);
      // useEffect on currentTenant will handle the redirect
    } catch {
      toast.error(t('auth.selectBusinessFailed'));
    } finally {
      setLoading(false);
    }
  }, [selectTenant, t]);

  const autoSelectAttempted = useRef(false);

  useEffect(() => {
    let active = true;
    if (user && currentTenant) {
      router.push(getLandingPage());
    } else if (user && tenants.length === 1 && !autoSelectAttempted.current) {
      autoSelectAttempted.current = true;
      selectTenant(tenants[0].id)
        .catch(() => { if (active) toast.error(t('auth.selectBusinessFailed')); })
        .finally(() => { if (active) setLoading(false); });
    }
    return () => { active = false; };
  }, [user, tenants, currentTenant, router, selectTenant, t]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setLoginError(null);
    try {
      await login(email, password, rememberMe);
      toast.success(t('auth.signInSuccess'));
    } catch (err: unknown) {
      const error = err as { response?: { status?: number; data?: { error?: string; attempts_remaining?: number; lockout_minutes?: number } } };
      const status = error.response?.status;
      const data = error.response?.data;

      if (status === 401) {
        const remaining = data?.attempts_remaining;
        if (remaining === 0) {
          // Just got locked out
          const mins = data?.lockout_minutes ?? 15;
          setLoginError(t('auth.lockedOut').replace('{minutes}', String(mins)));
        } else if (typeof remaining === 'number' && remaining < 4) {
          // Warn only when getting close (≤ 4 remaining to avoid noise on first attempt)
          setLoginError(
            t('auth.invalidCredentials') + ' ' +
            t('auth.attemptsRemaining').replace('{count}', String(remaining))
          );
        } else {
          setLoginError(t('auth.invalidCredentials'));
        }
      } else if (status === 429) {
        // Middleware-level lockout (authRateLimit window exhausted)
        const msg = data?.error || t('auth.lockedOut').replace('{minutes}', '15');
        setLoginError(msg);
      } else {
        const msg = data?.error || t('auth.loginFailed');
        setDbError(msg);
      }
    } finally {
      setLoading(false);
    }
  };



  const shouldShowTenantSelect = !!(user && (tenants.length > 1 || searchParams.get('select_tenant') === 'true'));

  const servaPanel = (
    <div className="relative hidden overflow-hidden bg-primary lg:block">
      <div className="pointer-events-none absolute -right-24 -top-24 size-80 rounded-full bg-white/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-28 -left-20 size-80 rounded-full bg-black/10 blur-3xl" />
      {/* floating food tiles — clustered on the right, clear of the copy */}
      <FoodTile art="f-burger" bg="#FFFFFF" size={124} className="absolute right-6 top-8 rotate-6 shadow-[0_20px_52px_-18px_rgba(26,26,26,.5)]" />
      <FoodTile art="f-shake" bg="#FFF6E5" size={96} className="absolute right-10 top-1/2 -translate-y-1/2 -rotate-6 shadow-[0_16px_40px_-14px_rgba(26,26,26,.45)]" />
      <FoodTile art="f-fries" bg="#FFFFFF" size={108} className="absolute bottom-8 right-7 -rotate-3 shadow-[0_16px_40px_-14px_rgba(26,26,26,.45)]" />
      <div className="relative z-10 flex h-full flex-col justify-between p-10 text-primary-foreground">
        <div className="flex items-center gap-2.5">
          <div className="grid size-9 place-items-center rounded-xl bg-white/15 text-base font-bold">P</div>
          <div className="leading-tight">
            <p className="text-[15px] font-bold">Plemmo</p>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-white/60">POS System</p>
          </div>
        </div>
        <div className="max-w-xs">
          <h1 className="text-[30px] font-bold leading-[1.15]">Run the whole counter from one calm screen.</h1>
          <p className="mt-4 text-sm leading-relaxed text-white/75">Sales, stock, staff and reports — offline-first, running on your own machine.</p>
        </div>
        <p className="text-xs text-white/50">Plemmo EPOS</p>
      </div>
    </div>
  );

  const mobileWordmark = (
    <div className="mb-8 flex items-center gap-2.5 lg:hidden">
      <div className="grid size-9 place-items-center rounded-xl bg-primary text-base font-bold text-primary-foreground">P</div>
      <div className="leading-tight">
        <p className="text-[15px] font-bold text-foreground">Plemmo</p>
        <p className="text-[10px] font-semibold uppercase tracking-widest text-text-subtle">POS System</p>
      </div>
    </div>
  );

  const shell = (children: React.ReactNode) => (
    <div className="grid min-h-screen place-items-center bg-background p-4 sm:p-6">
      <FoodSprite />
      <div className="grid w-full max-w-[1000px] overflow-hidden rounded-[28px] border border-hairline bg-card shadow-lg lg:min-h-[600px] lg:grid-cols-[1.05fr_1fr]">
        {servaPanel}
        <div className="flex items-center justify-center p-8 sm:p-12">
          <div className="w-full max-w-sm">{children}</div>
        </div>
      </div>
    </div>
  );

  if (shouldShowTenantSelect) {
    return shell(
      <>
        {mobileWordmark}
        <p className="text-xs font-bold uppercase tracking-widest text-text-subtle">{t('auth.selectBusinessHint')}</p>
        <h2 className="mb-8 mt-1.5 text-2xl font-bold text-foreground">{t('auth.selectBusiness')}</h2>
        <div className="space-y-3">
          {tenants.map((tenant) => (
            <button
              key={tenant.id}
              onClick={() => handleTenantSelect(tenant.id)}
              disabled={loading}
              className="group w-full rounded-2xl border border-hairline bg-surface p-4 text-left transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
            >
              <div className="font-bold text-foreground group-hover:text-primary">{tenant.business_name}</div>
              <div className="mt-0.5 text-sm text-muted-foreground">{t(BUSINESS_TYPE_LABEL_KEYS[tenant.business_type ?? ''] ?? tenant.business_type ?? '')} &middot; {t(ROLE_LABEL_KEYS[tenant.role ?? ''] ?? tenant.role ?? '')}</div>
            </button>
          ))}
        </div>
      </>
    );
  }

  return shell(
    <>
      {mobileWordmark}
      <p className="text-xs font-bold uppercase tracking-widest text-text-subtle">{t('auth.signInTitle')}</p>
      <h2 className="mb-8 mt-1.5 text-2xl font-bold text-foreground">{t('auth.signIn')}</h2>

      {dbError && (
        <div className="mb-5 rounded-xl border border-destructive/40 bg-danger-tint px-4 py-3 text-sm text-destructive">
          <strong>{t('auth.dbErrorPrefix')}</strong> {dbError}
        </div>
      )}

      <form onSubmit={handleLogin} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="email">{t('auth.email')}</Label>
              <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('auth.emailPlaceholder')} className="h-12 rounded-xl" required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{t('auth.password')}</Label>
              <div className="relative">
                <Input id="password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('auth.passwordPlaceholder')} className="h-12 rounded-xl pr-10" required />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="rounded border-input text-primary focus:ring-primary"
              />
              {t('auth.rememberMe')}
            </label>
            {loginError && (
              <p className="text-center text-sm text-destructive">{loginError}</p>
            )}
            <Button type="submit" disabled={loading} className="h-12 w-full rounded-xl text-base font-bold">
              {loading ? t('auth.signingIn') : t('auth.signIn')}
            </Button>
            <button
              type="button"
              onClick={() => router.push('/auth/recover')}
              className="w-full text-center text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {t('auth.forgotPasswordLink')}
            </button>
          </form>
    </>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginContent />
    </Suspense>
  );
}
