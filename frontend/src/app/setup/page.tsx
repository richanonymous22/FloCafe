'use client';

import { useState, useEffect } from 'react';
import api from '@/lib/api';
import { BRAND_TERMS_URL, BRAND_PRIVACY_URL, BRAND_DISCLAIMER_URL } from '@/lib/brand';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore } from '@/store/pos-settings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { FoodSprite, FoodTile } from '@/components/brand/FoodSprite';
import {
  ArrowLeft, ArrowRight, Check, Cloud, Database, KeyRound, Search, Sparkles,
  UtensilsCrossed, Eye, EyeOff, Languages, UserPlus, Zap, Wine, Store, ShoppingBag,
  ScanBarcode, Boxes, ChefHat, type LucideIcon,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { COUNTRIES, getCountryByCode, countryName, type Country } from '@/lib/countries';
import { getBrowserLanguage, t as translate, type Language } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type SetupProfile = 'empty' | 'express' | 'demo';
type ServiceModel = 'qsr' | 'finedine';
type BusinessType = 'restaurant' | 'retail';

const SETUP_PROFILES: Array<{ value: SetupProfile; badge?: 'express' | null }> = [
  { value: 'empty' }, { value: 'express', badge: 'express' }, { value: 'demo' },
];
const SERVICE_MODELS: Array<{ value: ServiceModel }> = [{ value: 'qsr' }, { value: 'finedine' }];

const DEFAULT_CLOUD_SERVER_URL = 'https://blue.flopos.com/';

// Seven steps: Business → Region → Security → Account → Data → Cloud → Finish.
const STEP_SHORT = ['Business', 'Region', 'Security', 'Account', 'Data', 'Cloud', 'Finish'];
const PROFILE_ICON: Record<SetupProfile, LucideIcon> = { empty: UtensilsCrossed, express: Sparkles, demo: Database };
const SERVICE_ICON: Record<ServiceModel, LucideIcon> = { qsr: Zap, finedine: Wine };
const LANG_FLAG: Record<string, string> = { en: '🇬🇧', es: '🇪🇸', pt: '🇵🇹', fa: '🇮🇷' };

function flagEmoji(code: string): string {
  if (!code || code.length !== 2) return '🏳️';
  const base = 0x1f1e6;
  return String.fromCodePoint(...[...code.toUpperCase()].map((ch) => base + ch.charCodeAt(0) - 65));
}

function LegalLink({ href, children }: { href: string; children: React.ReactNode }) {
  if (!href) return <span className="font-medium text-foreground">{children}</span>;
  return <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline">{children}</a>;
}

export default function SetupPage() {
  const { logout } = useAuthStore();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [showMasterPin, setShowMasterPin] = useState(false);
  const [showConfirmMasterPin, setShowConfirmMasterPin] = useState(false);
  const [businessType, setBusinessType] = useState<BusinessType>('restaurant');
  const [profile, setProfile] = useState<SetupProfile>('express');
  const [serviceModel, setServiceModel] = useState<ServiceModel>('qsr');
  const [language, setLanguage] = useState<Language>(() => getBrowserLanguage());
  const [browserLanguage] = useState<Language>(() => getBrowserLanguage());
  const [country, setCountry] = useState<string>('IN');
  const [countryQuery, setCountryQuery] = useState<string>('');
  const [form, setForm] = useState({ name: '', email: '', password: '', confirmPassword: '', business_name: '' });
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [productUpdates, setProductUpdates] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const passwordsEntered = form.password.length > 0 && form.confirmPassword.length > 0;
  const passwordsMatch = !passwordsEntered || form.password === form.confirmPassword;
  const isRetail = businessType === 'retail';

  const [masterPinAvailable, setMasterPinAvailable] = useState<boolean | null>(null);
  const [masterPin, setMasterPin] = useState('');
  const [masterPinConfirm, setMasterPinConfirm] = useState('');
  const masterPinValid = /^\d{4}$/.test(masterPin) && masterPin === masterPinConfirm;

  const cloudEnabled = true;
  const [cloudServerUrl, setCloudServerUrl] = useState(DEFAULT_CLOUD_SERVER_URL);

  const isPasswordValid = (password: string) => {
    if (!password || password.length < 8) return false;
    if (!/[A-Z]/.test(password)) return false;
    if (!/[a-z]/.test(password)) return false;
    if (!/[0-9]/.test(password)) return false;
    return true;
  };
  const passwordMeetsRequirements = form.password.length === 0 || isPasswordValid(form.password);

  useEffect(() => {
    let mounted = true;
    api.get('/auth/setup/status')
      .then(({ data }) => {
        if (!mounted) return;
        setMasterPinAvailable(!!data.masterPinAvailable);
        if (!data.needsSetup) {
          toast.error('Setup has already been completed on this install. Redirecting to login…');
          window.location.replace('/auth/login');
        }
      })
      .catch((err: unknown) => {
        if (!mounted) return;
        console.warn('[Setup] Failed to check setup status:', err);
        setMasterPinAvailable(false);
      });
    return () => { mounted = false; };
  }, []);

  const selectedCountry: Country | undefined = getCountryByCode(country);
  const q = countryQuery.trim().toLowerCase();
  const languageOptions: Language[] = browserLanguage === 'es' ? ['es', 'pt', 'en'] : browserLanguage === 'pt' ? ['pt', 'es', 'en'] : ['en', 'es', 'pt'];
  const filteredCountries = COUNTRIES.filter((c) => {
    if (!q) return true;
    return (
      countryName(c.code).toLowerCase().includes(q) || c.code.toLowerCase().includes(q) ||
      c.currency.toLowerCase().includes(q) || (c.locale ?? '').toLowerCase().includes(q)
    );
  });

  const t = (key: string) => translate(key, language);

  const completeSetup = () => {
    usePosSettingsStore.getState().setLanguage(language);
    api.put(`/settings/language`, { value: language }).catch((err: unknown) => {
      console.warn('[Setup] Failed to persist language setting:', err);
    });
    logout();
    toast.success(t('setup.completeSetupSuccess'));
    window.location.replace('/auth/login');
  };

  const validateOwner = () => {
    if (!form.name.trim() || !form.email.trim() || !form.password) { toast.error(t('setup.errorNameRequired')); return false; }
    if (!isPasswordValid(form.password)) { toast.error(t('setup.errorPasswordRequirementsNotMet')); return false; }
    if (form.password !== form.confirmPassword) { toast.error(t('setup.errorPasswordMismatch')); return false; }
    if (!termsAccepted) { toast.error(t('setup.errorTermsRequired')); return false; }
    return true;
  };

  const handleOwnerSubmit = (e: React.FormEvent) => { e.preventDefault(); if (validateOwner()) setStep(5); };

  const handleCompleteSetup = async () => {
    if (loading) return;
    if (!validateOwner()) { setStep(4); return; }
    if (masterPinAvailable && !masterPinValid) { toast.error(t('setup.masterPinRequired')); setStep(3); return; }
    if (cloudEnabled && cloudServerUrl.trim()) {
      try {
        const parsed = new URL(cloudServerUrl.trim());
        const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
        if (parsed.protocol !== 'https:' && !localHttp) { toast.error('Cloud server URL must use HTTPS (or local HTTP for development)'); setStep(6); return; }
      } catch { toast.error('Please enter a valid Cloud server URL'); setStep(6); return; }
    }
    setLoading(true);
    try {
      const countryProfile = selectedCountry;
      const countryCode = countryProfile?.code || country;
      await api.post('/auth/setup/initialize', {
        name: form.name, email: form.email, password: form.password,
        business_type: businessType, business_name: form.business_name || undefined,
        setup_profile: profile, service_model: isRetail ? 'qsr' : serviceModel, terms_accepted: termsAccepted,
        master_pin: masterPinAvailable ? masterPin : undefined,
        cloud_sync_enabled: true, cloud_server_url: cloudServerUrl.trim() || DEFAULT_CLOUD_SERVER_URL,
        email_product_updates: productUpdates, email_marketing: marketing,
        country: countryCode, currency: countryProfile?.currency, timezone: countryProfile?.timezone, language,
      });
      completeSetup();
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      toast.error(axiosErr.response?.data?.error || t('setup.errorGeneric'));
    } finally { setLoading(false); }
  };

  const stepMeta = getStepMeta(step, businessType, t);

  return (
    <div className="relative min-h-screen overflow-hidden bg-background">
      <FoodSprite />
      <FoodTile art={isRetail ? 'f-water' : 'f-burger'} bg="#FFFFFF" size={150} className="pointer-events-none absolute -left-10 bottom-16 hidden -rotate-12 opacity-[0.05] xl:block" />
      <FoodTile art="f-bowl" bg="#FFFFFF" size={130} className="pointer-events-none absolute -right-8 top-44 hidden rotate-12 opacity-[0.05] xl:block" />

      <header className="sticky top-0 z-20 border-b border-hairline bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="grid size-9 place-items-center rounded-xl bg-primary text-base font-bold text-primary-foreground">P</div>
            <div className="leading-tight">
              <p className="text-[15px] font-bold">Plemmo</p>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-text-subtle">POS System</p>
            </div>
          </div>
          <div className="mx-auto hidden lg:block"><TopStepper step={step} /></div>
          <div className="ml-auto text-sm font-semibold text-foreground lg:ml-0">Step {step} <span className="text-text-subtle">/ 7</span></div>
        </div>
        <div className="px-6 pb-3 lg:hidden"><Progress value={(step / 7) * 100} /></div>
      </header>

      <main className="relative z-10 mx-auto max-w-[720px] px-6 pb-28 pt-12">
        <div key={step} className="animate-rise">
          <StepHeader icon={stepMeta.icon} title={stepMeta.title} subtitle={stepMeta.subtitle} />

          {/* Step 1 — Business type */}
          {step === 1 && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <TypeCard selected={businessType === 'restaurant'} onClick={() => setBusinessType('restaurant')}
                  icon={ChefHat} title="Restaurant" desc="Dine-in, takeaway and delivery."
                  points={['Tables & floor plan', 'Kitchen display (KDS)', 'Modifiers & courses']} />
                <TypeCard selected={businessType === 'retail'} onClick={() => setBusinessType('retail')}
                  icon={ShoppingBag} title="Retail" desc="Shops and fast counter sales."
                  points={['Barcode & SKU search', 'Stock & stocktake', 'Suppliers & purchase orders']} />
              </div>
              <NavRow onNext={() => setStep(2)} nextLabel={t('setup.continue')} />
            </div>
          )}

          {/* Step 2 — Region (language + country) */}
          {step === 2 && (
            <div className="space-y-8">
              <div className="grid grid-cols-3 gap-3">
                {languageOptions.map((option) => {
                  const selected = language === option;
                  const label = option === 'es' ? t('setup.languageSpanish') : option === 'pt' ? t('setup.languagePortuguese') : t('setup.languageEnglish');
                  return (
                    <button key={option} onClick={() => setLanguage(option)} className={cn(selCls(selected), 'flex flex-col items-center gap-2 py-5')}>
                      {selected && <Badge />}
                      <span className="text-4xl leading-none">{LANG_FLAG[option] ?? '🌐'}</span>
                      <span className="text-sm font-bold">{label}</span>
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-text-subtle">{option}</span>
                    </button>
                  );
                })}
              </div>
              <div>
                <div className="mb-3 flex items-end justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-bold">{t('setup.chooseCountry')}</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">{t('setup.chooseCountryHint')}</p>
                  </div>
                  <span className="hidden items-center gap-1.5 rounded-full bg-accent px-3 py-1 text-xs font-bold text-primary sm:inline-flex">
                    <span className="text-base leading-none">{flagEmoji(country)}</span> {countryName(country)}
                  </span>
                </div>
                <div className="relative mb-3">
                  <Search size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-text-subtle" />
                  <Input value={countryQuery} onChange={(e) => setCountryQuery(e.target.value)} placeholder={t('setup.searchPlaceholder')} className="h-12 rounded-xl pl-11" />
                </div>
                <div className="grid max-h-[320px] grid-cols-1 gap-2.5 overflow-y-auto pr-1 sm:grid-cols-2">
                  {filteredCountries.map((c) => {
                    const selected = country === c.code;
                    return (
                      <button key={c.code} onClick={() => setCountry(c.code)} className={cn(selCls(selected), 'flex items-center gap-3 !p-3')}>
                        <span className="text-2xl leading-none">{flagEmoji(c.code)}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-bold">{countryName(c.code)}</span>
                          <span className="block truncate text-xs text-muted-foreground">{c.currency} · {c.locale}</span>
                        </span>
                        {selected && <Check className="size-4 shrink-0 text-primary" />}
                      </button>
                    );
                  })}
                  {q && filteredCountries.length === 0 && (
                    <p className="col-span-full py-8 text-center text-sm text-muted-foreground">{t('setup.noMatches').replace('{query}', countryQuery)}</p>
                  )}
                </div>
              </div>
              <NavRow onBack={() => setStep(1)} backLabel={t('setup.back')} onNext={() => setStep(3)} nextLabel={t('setup.continue')} />
            </div>
          )}

          {/* Step 3 — Security PIN */}
          {step === 3 && (
            <div className="space-y-6">
              <p className="mx-auto max-w-md rounded-xl bg-muted px-4 py-3 text-center text-xs text-muted-foreground">{t('setup.masterPinRecoveryNote')}</p>
              {masterPinAvailable === false ? (
                <p className="mx-auto max-w-md rounded-xl bg-muted p-4 text-center text-sm text-muted-foreground">{t('setup.masterPinNotAvailable')}</p>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <PinField id="master-pin" label={t('setup.pinLabel')} value={masterPin} onChange={setMasterPin} show={showMasterPin} onToggle={() => setShowMasterPin(!showMasterPin)} />
                  <PinField id="master-pin-confirm" label={t('setup.confirmPinLabel')} value={masterPinConfirm} onChange={setMasterPinConfirm} show={showConfirmMasterPin} onToggle={() => setShowConfirmMasterPin(!showConfirmMasterPin)} />
                </div>
              )}
              <NavRow onBack={() => setStep(2)} backLabel={t('setup.back')} onNext={() => setStep(4)} nextLabel={t('setup.continue')} nextDisabled={masterPinAvailable === true && !masterPinValid} />
            </div>
          )}

          {/* Step 4 — Owner account */}
          {step === 4 && (
            <form onSubmit={handleOwnerSubmit} className="space-y-5">
              <Field label={t('setup.ownerName')} htmlFor="name"><Input id="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t('setup.ownerNamePlaceholder')} className="h-12 rounded-xl" required /></Field>
              <Field label={t('setup.ownerEmail')} htmlFor="email"><Input id="email" type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder={t('setup.ownerEmailPlaceholder')} className="h-12 rounded-xl" required /></Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('setup.password')} htmlFor="password"><PwField id="password" value={form.password} onChange={(v) => setForm({ ...form, password: v })} placeholder={t('setup.passwordPlaceholder')} show={showPassword} onToggle={() => setShowPassword(!showPassword)} autoComplete="new-password" /></Field>
                <Field label={t('setup.confirmPassword')} htmlFor="confirmPassword"><PwField id="confirmPassword" value={form.confirmPassword} onChange={(v) => setForm({ ...form, confirmPassword: v })} placeholder={t('setup.confirmPasswordPlaceholder')} show={showConfirmPassword} onToggle={() => setShowConfirmPassword(!showConfirmPassword)} autoComplete="new-password" /></Field>
              </div>
              {!passwordMeetsRequirements && <p className="text-xs font-semibold text-destructive">Password must be at least 8 characters and include an uppercase letter, a lowercase letter, and a number.</p>}
              {passwordsEntered && <p className={cn('text-xs font-semibold', passwordsMatch ? 'text-success' : 'text-destructive')}>{passwordsMatch ? t('setup.passwordsMatch') : t('setup.passwordsMismatch')}</p>}
              <Field label={t('setup.businessName')} htmlFor="business_name"><Input id="business_name" value={form.business_name} onChange={(e) => setForm({ ...form, business_name: e.target.value })} placeholder={t('setup.businessNamePlaceholder')} className="h-12 rounded-xl" /></Field>
              <label className="flex items-start gap-2.5 text-sm text-muted-foreground">
                <input type="checkbox" checked={termsAccepted} onChange={(e) => setTermsAccepted(e.target.checked)} className="mt-0.5 size-4 rounded border-border-strong text-primary" required />
                <span>{t('setup.termsIntro')}{' '}<LegalLink href={BRAND_TERMS_URL}>{t('setup.terms')}</LegalLink>, <LegalLink href={BRAND_PRIVACY_URL}>{t('setup.privacy')}</LegalLink>, and <LegalLink href={BRAND_DISCLAIMER_URL}>{t('setup.disclaimer')}</LegalLink>.</span>
              </label>
              <div className="space-y-3 rounded-2xl border border-hairline px-4 py-3.5 text-sm">
                <p className="font-bold text-foreground">Email communication</p>
                <label className="flex items-start gap-2.5"><input type="checkbox" checked={productUpdates} onChange={(e) => setProductUpdates(e.target.checked)} className="mt-0.5 size-4 rounded border-border-strong text-primary" /><span>Product updates and release notes (optional)</span></label>
                <label className="flex items-start gap-2.5"><input type="checkbox" checked={marketing} onChange={(e) => setMarketing(e.target.checked)} className="mt-0.5 size-4 rounded border-border-strong text-primary" /><span>Marketing messages, offers and surveys (optional)</span></label>
              </div>
              <NavRow onBack={() => setStep(3)} backLabel={t('setup.back')} submit nextLabel={t('setup.continue')} nextDisabled={!passwordsMatch || !termsAccepted || !isPasswordValid(form.password)} />
            </form>
          )}

          {/* Step 5 — Starter data */}
          {step === 5 && (
            <div className="space-y-4">
              {SETUP_PROFILES.map((item) => {
                const selected = profile === item.value;
                const Icon = PROFILE_ICON[item.value];
                return (
                  <button key={item.value} onClick={() => setProfile(item.value)} className={cn(selCls(selected), 'flex w-full items-start gap-4')}>
                    <span className={cn('flex size-12 shrink-0 items-center justify-center rounded-xl', selected ? 'bg-primary text-primary-foreground' : 'bg-accent text-primary')}><Icon className="size-6" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="font-bold">{t(`setup.${item.value}Label`)}</span>
                        {item.badge && <span className="rounded-full bg-primary px-2 py-0.5 text-[11px] font-bold text-primary-foreground">{t('setup.expressBadge')}</span>}
                      </span>
                      <span className="mt-1 block text-sm text-muted-foreground">{profileDesc(item.value, isRetail, t)}</span>
                    </span>
                    {selected && <Check className="size-5 shrink-0 text-primary" />}
                  </button>
                );
              })}
              <NavRow onBack={() => setStep(4)} backLabel={t('setup.back')} onNext={() => setStep(6)} nextLabel={t('setup.continue')} />
            </div>
          )}

          {/* Step 6 — Cloud */}
          {step === 6 && (
            <div className="space-y-5">
              <div className="flex items-start gap-3 rounded-2xl border-2 border-primary bg-accent p-4">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"><Check className="size-4" /></span>
                <span>
                  <span className="font-bold text-foreground">Cloud services are enabled automatically</span>
                  <span className="mt-1 block text-sm text-muted-foreground">Plemmo connects so device pairing and support work without a manual approval step.</span>
                </span>
              </div>
              <Field label={t('setup.cloudUrlLabel')} htmlFor="cloud-server-url" hint={t('setup.cloudUrlHint')}><Input id="cloud-server-url" type="url" value={cloudServerUrl} onChange={(e) => setCloudServerUrl(e.target.value)} placeholder={DEFAULT_CLOUD_SERVER_URL} className="h-12 rounded-xl" /></Field>
              <NavRow onBack={() => setStep(5)} backLabel={t('setup.back')} onNext={() => setStep(7)} nextLabel={t('setup.continue')} />
            </div>
          )}

          {/* Step 7 — Finish (service model for restaurant, review for retail) */}
          {step === 7 && !isRetail && (
            <div className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                {SERVICE_MODELS.map((item) => {
                  const selected = serviceModel === item.value;
                  const Icon = SERVICE_ICON[item.value];
                  return (
                    <button key={item.value} onClick={() => setServiceModel(item.value)} className={cn(selCls(selected), 'flex flex-col gap-3 !p-5')}>
                      {selected && <Badge />}
                      <span className={cn('flex size-12 items-center justify-center rounded-xl', selected ? 'bg-primary text-primary-foreground' : 'bg-accent text-primary')}><Icon className="size-6" /></span>
                      <span className="text-lg font-bold">{t(`setup.${item.value}Label`)}</span>
                      <span className="text-sm text-muted-foreground">{t(`setup.${item.value}Desc`)}</span>
                    </button>
                  );
                })}
              </div>
              <NavRow onBack={() => setStep(6)} backLabel={t('setup.back')} onNext={handleCompleteSetup} loading={loading} nextLabel={loading ? t('setup.completingSetup') : t('setup.completeSetup')} nextDisabled={loading} />
            </div>
          )}
          {step === 7 && isRetail && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-hairline bg-card p-5 shadow-sm">
                <p className="eyebrow mb-3">Review</p>
                <dl className="divide-y divide-hairline text-sm">
                  <ReviewRow label="Business" value={<span className="inline-flex items-center gap-2"><ShoppingBag className="size-4 text-primary" /> Retail</span>} />
                  <ReviewRow label="Country" value={<span className="inline-flex items-center gap-2"><span className="text-base">{flagEmoji(country)}</span> {countryName(country)} · {selectedCountry?.currency}</span>} />
                  <ReviewRow label="Starter data" value={t(`setup.${profile}Label`)} />
                  <ReviewRow label="Owner" value={form.name || '—'} />
                </dl>
              </div>
              <p className="rounded-xl bg-muted px-4 py-3 text-xs text-muted-foreground">Your retail till, catalogue, stock and reports are ready. You can add products or import a catalogue right after sign-in.</p>
              <NavRow onBack={() => setStep(6)} backLabel={t('setup.back')} onNext={handleCompleteSetup} loading={loading} nextLabel={loading ? t('setup.completingSetup') : t('setup.completeSetup')} nextDisabled={loading} />
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

/* ── Step metadata (business-type aware) ───────────────────────────────── */
function getStepMeta(step: number, bt: BusinessType, t: (k: string) => string): { icon: LucideIcon; title: string; subtitle: string } {
  const retail = bt === 'retail';
  const table: { icon: LucideIcon; title: string; subtitle: string }[] = [
    { icon: Store, title: 'Choose your business type', subtitle: 'Plemmo tailors the till, stock and reports to how you sell.' },
    { icon: Languages, title: t('setup.chooseLanguage'), subtitle: t('setup.chooseLanguageHint') },
    { icon: KeyRound, title: t('setup.setMasterPinTitle'), subtitle: t('setup.setMasterPinDescription') },
    { icon: UserPlus, title: t('setup.createOwner'), subtitle: t('setup.ownerSubtitle') },
    { icon: retail ? Boxes : Database, title: t('setup.setupDataTitle'), subtitle: t('setup.setupDataSubtitle') },
    { icon: Cloud, title: t('setup.cloudTitle'), subtitle: t('setup.cloudSubtitle') },
    retail
      ? { icon: ScanBarcode, title: 'You’re all set', subtitle: 'Review your choices and finish setup.' }
      : { icon: UtensilsCrossed, title: t('setup.flowTitle'), subtitle: t('setup.flowSubtitle') },
  ];
  return table[step - 1];
}

function profileDesc(p: SetupProfile, retail: boolean, t: (k: string) => string) {
  if (!retail) return t(`setup.${p}Desc`);
  return p === 'empty' ? 'Owner account and required settings only.'
    : p === 'express' ? 'A ready-to-sell shop: starter categories and a few products.'
      : 'Sample products, customers and staff so you can explore the system.';
}

/* ── Presentational helpers ────────────────────────────────────────────── */
const selCls = (on: boolean) => cn(
  'relative rounded-2xl border-2 p-4 text-left transition-all',
  on ? 'border-primary bg-accent shadow-sm' : 'border-hairline bg-card hover:border-border-strong hover:shadow-sm'
);

function Badge() {
  return <span className="absolute right-3 top-3 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground"><Check className="size-3.5" /></span>;
}

function TypeCard({ selected, onClick, icon: Icon, title, desc, points }: {
  selected: boolean; onClick: () => void; icon: LucideIcon; title: string; desc: string; points: string[];
}) {
  return (
    <button onClick={onClick} className={cn(selCls(selected), 'flex flex-col gap-3 !p-6')}>
      {selected && <Badge />}
      <span className={cn('flex size-14 items-center justify-center rounded-2xl', selected ? 'bg-primary text-primary-foreground' : 'bg-accent text-primary')}><Icon className="size-7" /></span>
      <span className="text-xl font-bold">{title}</span>
      <span className="text-sm text-muted-foreground">{desc}</span>
      <ul className="mt-1 space-y-1.5">
        {points.map((p) => <li key={p} className="flex items-center gap-2 text-sm"><Check className="size-4 shrink-0 text-primary" /> {p}</li>)}
      </ul>
    </button>
  );
}

function ReviewRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-semibold text-foreground">{value}</dd>
    </div>
  );
}

function TopStepper({ step }: { step: number }) {
  return (
    <ol className="flex items-center gap-1.5">
      {STEP_SHORT.map((label, i) => {
        const n = i + 1;
        const done = n < step;
        const active = n === step;
        return (
          <li key={label} className="flex items-center gap-1.5">
            <span className={cn('flex items-center gap-2 rounded-full py-1 pl-1 pr-2.5 text-xs font-bold transition-colors', active ? 'bg-accent text-primary' : 'text-text-subtle')}>
              <span className={cn('flex size-6 items-center justify-center rounded-full text-[11px]', done || active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>
                {done ? <Check className="size-3.5" /> : n}
              </span>
              <span className={cn(!active && 'hidden 2xl:inline')}>{label}</span>
            </span>
            {n < STEP_SHORT.length && <span className={cn('h-px w-3', done ? 'bg-primary' : 'bg-border')} />}
          </li>
        );
      })}
    </ol>
  );
}

function StepHeader({ icon: Icon, title, subtitle }: { icon: LucideIcon; title: string; subtitle: string }) {
  return (
    <div className="mb-8 text-center">
      <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-accent text-primary shadow-sm"><Icon className="size-7" /></div>
      <h2 className="text-[26px] font-bold tracking-tight">{title}</h2>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">{subtitle}</p>
    </div>
  );
}

function NavRow({ onBack, backLabel, onNext, nextLabel, nextDisabled, loading, submit }: {
  onBack?: () => void; backLabel?: string; onNext?: () => void; nextLabel: string; nextDisabled?: boolean; loading?: boolean; submit?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 pt-2">
      {onBack && <button type="button" onClick={onBack} className="inline-flex h-12 items-center gap-1.5 rounded-xl border border-hairline px-5 text-sm font-semibold transition-colors hover:bg-hover"><ArrowLeft className="size-4" /> {backLabel}</button>}
      <Button type={submit ? 'submit' : 'button'} onClick={submit ? undefined : onNext} disabled={nextDisabled} className="h-12 flex-1 rounded-xl text-base font-bold">
        {nextLabel}{!loading && <ArrowRight className="size-4" />}
      </Button>
    </div>
  );
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
  return (<div className="space-y-2"><Label htmlFor={htmlFor}>{label}</Label>{children}{hint && <p className="text-xs text-muted-foreground">{hint}</p>}</div>);
}

function PwField({ id, value, onChange, placeholder, show, onToggle, autoComplete }: {
  id: string; value: string; onChange: (v: string) => void; placeholder: string; show: boolean; onToggle: () => void; autoComplete?: string;
}) {
  return (
    <div className="relative">
      <Input id={id} type={show ? 'text' : 'password'} autoComplete={autoComplete} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="h-12 rounded-xl pr-10" required />
      <button type="button" onClick={onToggle} tabIndex={-1} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground">{show ? <EyeOff size={16} /> : <Eye size={16} />}</button>
    </div>
  );
}

function PinField({ id, label, value, onChange, show, onToggle }: {
  id: string; label: string; value: string; onChange: (v: string) => void; show: boolean; onToggle: () => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input id={id} type={show ? 'text' : 'password'} inputMode="numeric" pattern="[0-9]*" maxLength={4} value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="••••" className="h-12 rounded-xl pr-10 text-center text-lg tracking-[0.5em]" />
        <button type="button" onClick={onToggle} tabIndex={-1} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground">{show ? <EyeOff size={16} /> : <Eye size={16} />}</button>
      </div>
    </div>
  );
}
