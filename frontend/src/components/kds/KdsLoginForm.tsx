'use client';

import { ChefHat } from 'lucide-react';
import { useI18n } from '@/hooks/useI18n';
import type { UseKdsConnectionResult } from '@/hooks/useKdsConnection';

export function KdsLoginForm({ conn }: { conn: UseKdsConnectionResult }) {
  const { t } = useI18n();
  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center p-4">
      <div className="grid w-full max-w-[840px] overflow-hidden rounded-[28px] border border-hairline bg-surface shadow-xl md:grid-cols-2">
        {/* Brand panel */}
        <div className="relative hidden flex-col justify-between bg-brand p-8 text-white md:flex">
          <div className="flex items-center gap-2">
            <div className="flex size-9 items-center justify-center rounded-xl bg-white/20 font-bold">P</div>
            <div className="leading-tight">
              <p className="font-bold">Plemmo</p>
              <p className="text-[11px] uppercase tracking-widest text-white/70">Kitchen Display</p>
            </div>
          </div>
          <div className="relative">
            <ChefHat size={64} className="mb-4 text-white/90" />
            <h2 className="text-2xl font-bold leading-tight">{t('kds.title')}</h2>
            <p className="mt-2 text-sm text-white/80">{t('kds.loginSubtitle')}</p>
          </div>
          <p className="text-xs text-white/60">{t('kds.loginHint')}</p>
        </div>

        {/* Form */}
        <div className="p-8">
          <div className="mb-6 md:hidden">
            <ChefHat size={40} className="mb-3 text-brand" />
            <h1 className="text-2xl font-bold text-foreground">{t('kds.title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t('kds.loginSubtitle')}</p>
          </div>

          <form data-testid="kds-login-form" onSubmit={conn.handleLogin} className="space-y-4">
            {conn.loginError && (
              <div role="alert" aria-live="polite" className="rounded-lg border border-destructive/30 bg-danger-tint px-4 py-3 text-sm text-destructive">
                {conn.loginError}
              </div>
            )}

            <div>
              <label htmlFor="kds-login-email" className="mb-1 block text-sm font-medium text-foreground">{t('auth.email')}</label>
              <input
                id="kds-login-email"
                data-testid="kds-login-email"
                type="email"
                value={conn.loginEmail}
                onChange={(e) => conn.setLoginEmail(e.target.value)}
                className="h-11 w-full rounded-xl border border-hairline px-4 text-sm outline-none transition-colors focus:border-input focus:ring-2 focus:ring-brand/20"
                placeholder="chef@flo.local"
                required
              />
            </div>

            <div>
              <label htmlFor="kds-login-password" className="mb-1 block text-sm font-medium text-foreground">{t('auth.password')}</label>
              <input
                id="kds-login-password"
                data-testid="kds-login-password"
                type="password"
                value={conn.loginPassword}
                onChange={(e) => conn.setLoginPassword(e.target.value)}
                className="h-11 w-full rounded-xl border border-hairline px-4 text-sm outline-none transition-colors focus:border-input focus:ring-2 focus:ring-brand/20"
                placeholder="••••••••"
                required
              />
            </div>

            <label className="flex cursor-pointer select-none items-center gap-2 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={conn.rememberMe}
                onChange={(e) => conn.setRememberMe(e.target.checked)}
                className="rounded border-border-strong text-brand focus:ring-brand"
              />
              {t('auth.rememberMe')}
            </label>

            <button
              data-testid="kds-login-submit"
              type="submit"
              disabled={conn.loginLoading}
              className="h-11 w-full rounded-xl bg-brand font-semibold text-white shadow-sm transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {conn.loginLoading ? t('auth.signingIn') : t('auth.signIn')}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
