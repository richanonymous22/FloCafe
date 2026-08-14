/**
 * Test: Plemmo authorization hardening (Milestone 8) — real HTTP-level
 * proof that `requirePermission()` (main/middleware/authorize.ts) is now
 * the canonical gate on the business-critical routes migrated in Part C,
 * that location/feature/permission checks compose correctly, and that
 * client-supplied organization/location/role values are never trusted.
 *
 * Covers Part G items 1-10. Uses real authenticated HTTP requests through
 * a real Express app — no mocks of AuthorizationService/FeatureService.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/plemmo-authorization-hardening.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plemmo-authz-hardening-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb, closeDatabase, assert, assertEqual, getResults, now,
  createApp, startServer, seedOwnerUser, seedManagerUser, seedCategory, seedProduct, api,
} = require('./helpers/test-setup');
const { grantLocationAccess } = require('../main/core/employee-access');
const { getOrganizationContext, getLocationContext, resetContextCache } = require('../main/core/context');
const { ulid } = require('../main/core/ids');
const { getJWTSecret } = require('../main/routes/auth');
const { registerHospitalityHooks } = require('../main/modules/hospitality/hooks');

const { orderRoutes } = require('../main/routes/orders');
const { staffRoutes } = require('../main/routes/staff');
const { locationRoutes } = require('../main/routes/locations');
const { reportRoutes } = require('../main/routes/reports');
const { retailRoutes } = require('../main/routes/retail');
const { tableRoutes } = require('../main/routes/tables');
const { inventoryRoutes } = require('../main/routes/inventory');
const { purchaseOrderRoutes } = require('../main/routes/purchase-orders');
const { transferRoutes } = require('../main/routes/transfers');
const { supplierRoutes } = require('../main/routes/suppliers');
const { featureRoutes } = require('../main/routes/features');

function setLocationPointer(db: any, locationId: string) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('plemmo_location_id', ?, ?)").run(locationId, now());
  resetContextCache();
}

function seedUser(db: any, userId: string, role: string): { userId: string; authHeader: Record<string, string> } {
  const passwordHash = bcrypt.hashSync('testpass123', 10);
  db.prepare(`INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).run(userId, `Test ${role}`, `${userId}@test.local`, passwordHash, role, now(), now());
  const token = jwt.sign({ userId, email: `${userId}@test.local`, role }, getJWTSecret(), { expiresIn: '1h' });
  return { userId, authHeader: { Authorization: `Bearer ${token}` } };
}

async function main() {
  console.log('Test: Plemmo authorization hardening (Milestone 8)');
  console.log('='.repeat(50));

  const db = initTestDb();
  registerHospitalityHooks();
  const organization = getOrganizationContext();
  const location = getLocationContext();

  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  const waiter = seedUser(db, 'waiter-h-001', 'waiter');
  const cashier = seedUser(db, 'cashier-h-001', 'cashier');
  grantLocationAccess(cashier.userId, location.id);
  seedCategory(db, 'cat-h', 'Hardening Test');
  seedProduct(db, 'prod-h', 'cat-h', 'Hardening Widget', 10);

  const app = createApp({
    '/api/orders': orderRoutes, '/api/staff': staffRoutes, '/api/locations': locationRoutes,
    '/api/reports': reportRoutes, '/api/retail': retailRoutes, '/api/tables': tableRoutes,
    '/api/inventory': inventoryRoutes, '/api/purchase-orders': purchaseOrderRoutes,
    '/api/transfers': transferRoutes, '/api/suppliers': supplierRoutes, '/api/features': featureRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n1. Allowed role + allowed location = success');
    const allowedSale = await api(baseUrl, '/api/orders', {
      method: 'POST', body: { type: 'takeaway', items: [{ product_id: 'prod-h', quantity: 1 }] }, headers: cashier.authHeader,
    });
    assertEqual(allowedSale.status, 201, 'cashier with sales.create and access to the device location can create a sale');

    console.log('\n2. Wrong role = 403');
    const waiterStaffAttempt = await api(baseUrl, '/api/staff', {
      method: 'POST', body: { name: 'New Hire', password: 'Password123', role: 'cashier' }, headers: waiter.authHeader,
    });
    assertEqual(waiterStaffAttempt.status, 403, 'a waiter lacks employees.manage — staff creation is rejected');

    console.log('\n3. Wrong location = 403');
    const secondLocationId = ulid();
    db.prepare(`INSERT INTO locations (id, organization_id, name, code, is_active, created_at, updated_at)
                VALUES (?, ?, 'Second Site', 'LOC-H2', 1, ?, ?)`).run(secondLocationId, organization.id, now(), now());
    // sales.create's location check resolves the *device's own* current
    // location (SaleService never accepts a client-supplied one), so this
    // simulates the cashier's till now sitting at Location B — the same
    // technique tests/plemmo-multi-location.test.ts uses to exercise real
    // location context without building a switcher UI.
    setLocationPointer(db, secondLocationId);
    const wrongLocationSale = await api(baseUrl, '/api/orders', {
      method: 'POST', body: { type: 'takeaway', items: [{ product_id: 'prod-h', quantity: 1 }] }, headers: cashier.authHeader,
    });
    assertEqual(wrongLocationSale.status, 403, 'a cashier with no grant for the device\'s current location cannot create a sale there, even though sales.create itself allows the role');

    console.log('\n4. Feature disabled = 403');
    const revokeTables = await api(baseUrl, '/api/features/hospitality.tables/revoke', { method: 'POST', headers: owner.authHeader });
    assertEqual(revokeTables.status, 200, 'the owner can revoke hospitality.tables');
    const blockedTable = await api(baseUrl, '/api/tables', { method: 'POST', body: { number: 'T-99', capacity: 4 }, headers: owner.authHeader });
    assertEqual(blockedTable.status, 403, 'table creation is rejected while hospitality.tables is disabled');

    console.log('\n5. Feature enabled = success');
    const grantTables = await api(baseUrl, '/api/features/hospitality.tables/grant', { method: 'POST', headers: owner.authHeader });
    assertEqual(grantTables.status, 200, 'the owner can grant hospitality.tables back');
    const allowedTable = await api(baseUrl, '/api/tables', { method: 'POST', body: { number: 'T-99', capacity: 4 }, headers: owner.authHeader });
    assertEqual(allowedTable.status, 201, 'table creation succeeds once hospitality.tables is enabled again');

    console.log('\n6. Client attempts to spoof organization = denied');
    // The features route never reads organization_id from the client at all
    // (main/routes/features.ts always resolves it via getCurrentOrganizationId()).
    // Sending one anyway must have no effect beyond being ignored.
    const spoofedOrgGrant = await api(baseUrl, '/api/features/retail.transfers/grant', {
      method: 'POST', body: { organization_id: 'org-does-not-exist' }, headers: owner.authHeader,
    });
    assertEqual(spoofedOrgGrant.status, 200, 'the request still succeeds against the real, server-resolved organization');
    const featuresAfterSpoof = await api(baseUrl, '/api/features', { headers: owner.authHeader });
    const transfersRow = featuresAfterSpoof.data.features.find((f: any) => f.key === 'retail.transfers');
    assert(transfersRow?.enabled === true, 'the grant landed on this install\'s real organization, not the spoofed one — a spoofed organization_id in the body has no effect');

    console.log('\n7. Client attempts to spoof location = denied');
    // The order route never reads a location from the request body at all
    // (main/core/sale.ts resolves it server-side from device context) — so
    // claiming a different, already-authorized location in the body has no
    // effect. The cashier is still rejected against the device's real
    // current location (Location B, from step 3).
    const spoofedLocationSale = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: 'prod-h', quantity: 1 }], location_id: location.id },
      headers: cashier.authHeader,
    });
    assertEqual(spoofedLocationSale.status, 403, 'naming a different, already-authorized location_id in the body does not bypass the server-resolved device location');
    grantLocationAccess(cashier.userId, secondLocationId);
    const nowAllowedSale = await api(baseUrl, '/api/orders', {
      method: 'POST', body: { type: 'takeaway', items: [{ product_id: 'prod-h', quantity: 1 }] }, headers: cashier.authHeader,
    });
    assertEqual(nowAllowedSale.status, 201, 'the identical request now succeeds once the device\'s real location is genuinely granted — proving the earlier 403 was a real check, not a broken route');
    setLocationPointer(db, location.id);

    console.log('\n8. Owner/manager compatibility remains correct');
    const managerPo = await api(baseUrl, '/api/suppliers', { method: 'POST', body: { name: 'Hardening Supplier' }, headers: manager.authHeader });
    assertEqual(managerPo.status, 201, 'a manager can still create a supplier (unrestricted role, no location grant needed)');
    const managerLocationsAttempt = await api(baseUrl, '/api/locations', {
      method: 'POST', body: { name: 'Manager Cannot Create This' }, headers: manager.authHeader,
    });
    assertEqual(managerLocationsAttempt.status, 403, 'locations.manage is owner-only — a manager is still correctly rejected, exactly as before requirePermission replaced requireRole here');
    const ownerLocations = await api(baseUrl, '/api/locations', { method: 'POST', body: { name: 'Owner Can Create This' }, headers: owner.authHeader });
    assertEqual(ownerLocations.status, 201, 'an owner can create a location');
    const managerReports = await api(baseUrl, '/api/reports/sales', { headers: manager.authHeader });
    assertEqual(managerReports.status, 200, 'a manager retains reports.view access via the canonical gate');

    console.log('\n9. Existing hospitality operations still work');
    const hospitalityOrder = await api(baseUrl, '/api/orders', {
      method: 'POST', body: { type: 'dine_in', table_id: null, items: [{ product_id: 'prod-h', quantity: 1 }] }, headers: owner.authHeader,
    });
    assertEqual(hospitalityOrder.status, 201, 'hospitality order creation is unaffected by the canonical permission gate');

    console.log('\n10. Existing retail operations still work');
    const retailSale = await api(baseUrl, '/api/retail/checkout', {
      method: 'POST',
      body: { lines: [{ product_id: 'prod-h', quantity: 1 }], tender: { adapter: 'cash', method: 'cash' } },
      headers: owner.authHeader,
    });
    assertEqual(retailSale.status, 201, 'retail checkout is unaffected — it still uses requireRole, deliberately not migrated (see docs/MILESTONE_8_AUTHORIZATION.md)');
  } finally {
    server.close();
  }

  closeDatabase();

  const { passed, failed } = getResults();
  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Test suite failed:', error);
  process.exit(1);
});
