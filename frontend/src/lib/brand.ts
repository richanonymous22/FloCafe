/**
 * Plemmo white-label brand seam.
 *
 * Every user-visible reference to the product vendor — the product name, the
 * legal documents a merchant accepts at setup, and the "about" links — reads
 * from here rather than being hard-coded at each call site. Plemmo is licensed
 * and white-labelled onward, so these have to be swappable in one place.
 *
 * URLs default to empty. Call sites MUST treat an empty URL as "hide this
 * link" rather than rendering a dead anchor: pointing a merchant at a legal
 * document that does not exist, or at the upstream FloCafe vendor's terms, is
 * worse than showing no link at all. Populate these before commercial
 * distribution — see docs/PLEMMO_ARCHITECTURE.md § Deferred.
 *
 * Phase 0 note: the values below deliberately do NOT reuse flopos.com. That
 * domain belongs to the upstream project this fork derives from and has no
 * relationship to Plemmo or its merchants.
 */

/** Product name shown in the UI chrome when a merchant has not set their own business name. */
export const BRAND_NAME = 'Plemmo EPOS';

/** Marketing/product site. Empty = the "App Website" link is hidden. */
export const BRAND_WEBSITE_URL = '';

/** Source/issue tracker link shown in Settings → About. Empty = hidden. */
export const BRAND_REPOSITORY_URL = '';

/** Terms of service accepted during first-run setup. Empty = plain text, no link. */
export const BRAND_TERMS_URL = '';

/** Privacy policy accepted during first-run setup. Empty = plain text, no link. */
export const BRAND_PRIVACY_URL = '';

/** Disclaimer accepted during first-run setup. Empty = plain text, no link. */
export const BRAND_DISCLAIMER_URL = '';
