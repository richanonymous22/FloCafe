/*
 * Floor-plan editor geometry helpers (window.FloorPlan) — Meridian integration.
 *
 * The editor's DOM/drag layer calls these pure helpers on a draft copy of the
 * tables; this verifies the mutation logic (add / move-with-clamp / validated
 * update / remove / next-name) against the built bundle, without a server or
 * pointer events. Persistence is exercised separately by test:meridian-tables
 * (PlemmoTables) and the backend tables suite.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';

function assert(cond: boolean, msg: string) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log('Testing floor-plan editor geometry helpers (jsdom)...');
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend-meridian', 'dist', 'meridian-pos.html'), 'utf8');

  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window: any) {
      window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
      window.scrollTo = () => {};
      // No backend in this test — the boot sequence's calls simply fail (offline).
      window.fetch = () => Promise.reject(new Error('offline'));
    },
  });

  try {
    const win = dom.window as any;
    await sleep(50); // let the inline script define globals
    const FP = win.FloorPlan;
    assert(!!FP, 'window.FloorPlan is exposed');

    // nextTableName: max numeric name + 1, ignoring non-numeric.
    assert(FP.nextTableName([{ name: '1' }, { name: '7' }, { name: 'Bar' }]) === '8', 'nextTableName picks max+1');
    assert(FP.nextTableName([]) === '1', 'nextTableName on empty → 1');

    // addTable: immutable, auto-named, defaults applied.
    const base = [{ id: 't1', name: '1', seats: 2, shape: 'round', size: 's', x: 5, y: 5, rotation: 0 }];
    const added = FP.addTable(base, {});
    assert(added.tables.length === 2 && base.length === 1, 'addTable is immutable');
    assert(added.table.name === '2', 'new table auto-named');
    assert(added.table.shape === 'square' && added.table.size === 'm' && added.table.seats === 4, 'defaults applied');

    // moveTable: clamps to 0..94 and rounds to 0.1.
    const moved = FP.moveTable(base, 't1', 200, -10);
    const m = moved.find((t: any) => t.id === 't1');
    assert(m.x === 94 && m.y === 0, 'moveTable clamps out-of-range coords');
    assert(base[0].x === 5, 'moveTable is immutable');

    // updateTable: validates enums, coerces seats/rotation, keeps identity on bad input.
    let up = FP.updateTable(base, 't1', { shape: 'hexagon', size: 'xl', seats: 0, rotation: 375, name: '  ' });
    const u = up.find((t: any) => t.id === 't1');
    assert(u.shape === 'round', 'invalid shape rejected (kept previous)');
    assert(u.size === 's', 'invalid size rejected (kept previous)');
    assert(u.seats === 1, 'seats floored to >= 1');
    assert(u.rotation === 15, 'rotation normalized modulo 360');
    assert(u.name === '1', 'blank name rejected (kept previous)');
    up = FP.updateTable(base, 't1', { shape: 'rect', seats: 6, rotation: -90, section: 'Terrace' });
    const u2 = up.find((t: any) => t.id === 't1');
    assert(u2.shape === 'rect' && u2.seats === 6 && u2.rotation === 270 && u2.section === 'Terrace', 'valid update applied');

    // removeTable: immutable filter.
    const rem = FP.removeTable(base, 't1');
    assert(rem.length === 0 && base.length === 1, 'removeTable is immutable');

    console.log('✅ Floor-plan editor geometry tests passed');
  } finally {
    dom.window.close();
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
