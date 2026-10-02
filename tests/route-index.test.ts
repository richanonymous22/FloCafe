/*
 * The route index (docs/ROUTE_INDEX.md) is generated from the source and must be current; it must list every route
 * a router file declares, and the money and licence routes must carry the guards the code declares.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

let passed = 0;
function ok(cond: boolean, msg: string) { if (!cond) throw new Error(`Assertion failed: ${msg}`); passed++; console.log(`  ✓ ${msg}`); }

const root = path.join(__dirname, '..');
console.log('Testing the generated route index...');
const check = spawnSync(process.execPath, [path.join(root, 'scripts', 'generate-route-index.cjs'), '--check'], { encoding: 'utf8' });
ok(check.status === 0, 'docs/ROUTE_INDEX.md is up to date with the source (' + (check.stdout + check.stderr).trim() + ')');

const md = fs.readFileSync(path.join(root, 'docs', 'ROUTE_INDEX.md'), 'utf8');
const has = (method: string, p: string, guard?: string) => md.split('\n').some((l) => l.startsWith(`| ${method} | \`${p}\` |`) && (!guard || l.includes(guard)));
ok(has('POST', '/api/bills/:id/payments') && has('POST', '/api/bills/:id/refund', 'role: owner, manager, cashier'), 'payments and refunds are listed with their guards');
ok(has('POST', '/api/card/attempts', 'role: owner, manager, cashier') && has('PUT', '/api/card/config', 'role: owner, manager'), 'card routes are listed with their guards');
ok(has('POST', '/api/reports/z', 'permission: reports.z') && has('POST', '/api/stocktakes', 'permission: inventory.stocktake'), 'permission guards are resolved');
ok(has('POST', '/api/activation', 'role: owner') && has('GET', '/api/health', 'public'), 'activation is owner-only and health is public');

// Every router.<method>('...') in the mounted router files is accounted for.
const routesDir = path.join(root, 'main', 'routes');
const indexSrc = fs.readFileSync(path.join(routesDir, 'index.ts'), 'utf8');
const mounted = new Set<string>();
for (const m of indexSrc.matchAll(/import\s*\{\s*([A-Za-z0-9_]+)\s*\}\s*from\s*'\.\/([A-Za-z0-9_-]+)'/g)) {
  if (new RegExp(`app\\.use\\('/api/[^']*',\\s*${m[1]}\\)`).test(indexSrc)) mounted.add(m[2]);
}
let declared = 0;
for (const f of mounted) declared += [...fs.readFileSync(path.join(routesDir, f + '.ts'), 'utf8').matchAll(/\nrouter\.(get|post|put|patch|delete)\(\s*['"`]/g)].length;
const listed = md.split('\n').filter((l) => /^\| (GET|POST|PUT|PATCH|DELETE) \|/.test(l)).length;
ok(listed >= declared, `the index lists at least every declared router route (${listed} listed, ${declared} declared in ${mounted.size} routers)`);
console.log(`\n✅ Route index passed (${passed} checks)`);
