/**
 * Brand configuration — the one place the product's name, company and links are defined.
 *
 * Source order: environment (`PLEMMO_BRAND_*`) over `brand/brand.json` over the built-in defaults below.
 * `brand.json` is shipped next to the app (extraResources) and read once at first use. Nothing here is a
 * domain the product talks to: an empty URL means "do not show this link".
 */
import * as fs from 'fs';
import * as path from 'path';

export interface Brand {
  productName: string;
  shortName: string;
  markLetter: string;
  companyName: string;
  poweredBy: string;
  supportEmail: string;
  websiteUrl: string;
  termsUrl: string;
  privacyUrl: string;
  driveBackupFolder: string;
}

const DEFAULTS: Brand = {
  productName: 'Meridian POS',
  shortName: 'Meridian',
  markLetter: 'M',
  companyName: 'Plemmo',
  poweredBy: 'Plemmo',
  supportEmail: '',
  websiteUrl: '',
  termsUrl: '',
  privacyUrl: '',
  driveBackupFolder: 'Meridian POS Backups',
};

const ENV: Record<keyof Brand, string> = {
  productName: 'PLEMMO_BRAND_NAME',
  shortName: 'PLEMMO_BRAND_SHORT_NAME',
  markLetter: 'PLEMMO_BRAND_MARK',
  companyName: 'PLEMMO_BRAND_COMPANY',
  poweredBy: 'PLEMMO_BRAND_POWERED_BY',
  supportEmail: 'PLEMMO_BRAND_SUPPORT_EMAIL',
  websiteUrl: 'PLEMMO_BRAND_WEBSITE_URL',
  termsUrl: 'PLEMMO_BRAND_TERMS_URL',
  privacyUrl: 'PLEMMO_BRAND_PRIVACY_URL',
  driveBackupFolder: 'PLEMMO_BRAND_DRIVE_FOLDER',
};

const URL_KEYS: Array<keyof Brand> = ['websiteUrl', 'termsUrl', 'privacyUrl'];

function candidatePaths(): string[] {
  const paths: string[] = [];
  const resources = (process as any).resourcesPath as string | undefined;
  if (resources) paths.push(path.join(resources, 'brand', 'brand.json'));
  paths.push(path.join(__dirname, '..', 'brand', 'brand.json'), path.join(__dirname, '..', '..', 'brand', 'brand.json'));
  return paths;
}

function clean(key: keyof Brand, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().slice(0, 200);
  if (URL_KEYS.includes(key)) return v === '' || /^https:\/\//i.test(v) ? v : null; // https only; never a script: or http: link
  if (key === 'supportEmail') return v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
  if (key === 'markLetter') return v ? Array.from(v)[0] : null;
  if ((key === 'productName' || key === 'shortName') && !v) return null;
  return v;
}

let cached: Brand | null = null;

export function getBrand(): Brand {
  if (cached) return cached;
  const out: Brand = { ...DEFAULTS };
  for (const p of candidatePaths()) {
    try {
      if (!fs.existsSync(p)) continue;
      const file = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
      for (const k of Object.keys(DEFAULTS) as Array<keyof Brand>) {
        const v = clean(k, file[k]);
        if (v !== null) out[k] = v;
      }
      break;
    } catch (e) {
      console.warn('[Brand] could not read', p, (e as Error).message);
    }
  }
  for (const k of Object.keys(DEFAULTS) as Array<keyof Brand>) {
    const raw = process.env[ENV[k]];
    if (raw !== undefined) { const v = clean(k, raw); if (v !== null) out[k] = v; }
  }
  cached = out;
  return out;
}

/** Test hook: forget the cached brand so the environment is read again. */
export function resetBrandCache(): void { cached = null; }

export const brandName = (): string => getBrand().productName;
