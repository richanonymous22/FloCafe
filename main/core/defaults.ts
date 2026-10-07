/**
 * Install-time regional defaults. This product is sold in the UK first, so a fresh install starts as
 * United Kingdom / pounds sterling / London time. These are only the fallbacks for a setting that has no
 * value yet: a merchant's own country, currency and time zone always win, and existing databases are never
 * rewritten (the settings rows already exist). First-run setup lets the merchant change all of them.
 */
export const DEFAULT_COUNTRY = 'GB';
export const DEFAULT_CURRENCY = 'GBP';
export const DEFAULT_CURRENCY_SYMBOL = '£';
export const DEFAULT_TIMEZONE = 'Europe/London';
export const DEFAULT_PHONE_PREFIX = '+44';
