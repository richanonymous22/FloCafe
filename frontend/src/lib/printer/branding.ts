/**
 * Receipt footer branding.
 *
 * Printed at the bottom of every customer receipt and tax bill, on thermal
 * and web output alike. This is platform branding, NOT the merchant's own
 * business name — the merchant's name is printed in the receipt header from
 * their business settings.
 *
 * Plemmo is a white-label platform: the eventual requirement is that this
 * footer is configurable per deployment (and removable entirely for
 * merchants who do not want it), driven from settings rather than from a
 * compile-time constant. Until that exists, an empty value here suppresses
 * the corresponding line — see printPoweredByFooter() in receipt-encoder.ts
 * and tax-bill-encoder.ts, which skip empty strings rather than emitting a
 * blank line.
 */
export const RECEIPT_BRANDING_NAME = 'Powered by Plemmo EPOS';
/**
 * Intentionally empty: no public Plemmo URL is committed to yet, and a
 * receipt that prints a URL which does not resolve is worse than one that
 * prints none. Set this (or, preferably, replace it with the configurable
 * setting described above) before commercial distribution.
 */
export const RECEIPT_BRANDING_URL = '';
