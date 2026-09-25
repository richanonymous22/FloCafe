/**
 * Plemmo Core — the current install's location identity.
 *
 * A local Plemmo install represents exactly one physical location, seeded
 * once by migration v68 (`plemmo_organization_hierarchy`) into
 * `organizations`/`locations` and pointed to by the `plemmo_location_id`/
 * `plemmo_organization_id` settings — a cheap settings read rather than a
 * query that has to assume there is exactly one row. This module is the one
 * place that reads those pointers, so every caller (InventoryService,
 * PurchaseOrderService, ReceivingService) resolves "the current location"
 * the same way. See docs/MILESTONE_5_PURCHASING_LOCATIONS.md § Location
 * model.
 *
 * Multi-location selection (a merchant with more than one physical store,
 * one till choosing which location it's operating for) is explicitly not
 * built here — see the same doc's Deferred work.
 */

import { getSettingValue } from '../db';

export function getCurrentLocationId(): string | null {
  return getSettingValue('plemmo_location_id') || null;
}

export function getCurrentOrganizationId(): string | null {
  return getSettingValue('plemmo_organization_id') || null;
}
