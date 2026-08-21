'use client';

/**
 * Plemmo retail till — Serva design language.
 *
 * Counter-sale screen matching the Serva reference 1:1 in look: a search/scan
 * bar, black-active category chips with count badges, soft category-tinted
 * product tiles, and a live order panel with a keypad-driven pay flow. Talks
 * only to the retail + catalogue APIs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, ScanLine, Trash2, Pause, Play, ShoppingBag, Minus, Plus, X,
} from 'lucide-react';
import { PaymentDialog } from '@/components/retail/PaymentDialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import api from '@/lib/api';
import { parseDbTimestamp } from '@/lib/utils';
import { cn } from '@/lib/utils';
import toast from 'react-hot-toast';

interface Product {
  id: string; category_id: string | null; name: string; price: number;
  sku: string | null; barcode: string | null; has_image?: boolean | number;
  updated_at?: string | null; track_inventory?: boolean | number;
  stock_quantity?: number | null; low_stock_threshold?: number | null;
}
interface Category { id: string; name: string; }
interface BasketLine { key: string; productId: string; variantId: string | null; name: string; price: number; quantity: number; }
interface HeldSale { id: string; at: number; lines: BasketLine[]; total: number; }

// Serva category tint palette (bg + illustration/foreground colour).
const TINTS = [
  { bg: '#FFF1E9', fg: '#FF5E00' },
  { bg: '#ECF8E7', fg: '#2E8412' },
  { bg: '#EEF3FF', fg: '#2A5BD7' },
  { bg: '#F9EFFF', fg: '#8A3FCB' },
  { bg: '#FFF6E5', fg: '#8A5B00' },
  { bg: '#FDF0E4', fg: '#C2410C' },
];

export default function RetailTillPage() {
  const fmt = useFormatCurrency();
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [lines, setLines] = useState<BasketLine[]>([]);
  const [held, setHeld] = useState<HeldSale[]>([]);
  const [payOpen, setPayOpen] = useState(false);
  const [paySession, setPaySession] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    Promise.all([
      api.get('/products', { params: { active: 'true' } }),
      api.get('/categories', { params: { active: 'true' } }),
    ])
      .then(([p, c]) => {
        if (!active) return;
        setProducts(p.data.products || []);
        setCategories((c.data.categories || []).map((x: Category) => ({ id: x.id, name: x.name })));
      })
      .catch(() => { if (active) toast.error('Could not load the catalogue'); })
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  const tintFor = useCallback((catId: string | null) => {
    if (!catId) return TINTS[0];
    const idx = categories.findIndex((c) => c.id === catId);
    return TINTS[(idx < 0 ? 0 : idx) % TINTS.length];
  }, [categories]);

  const subtotal = useMemo(() => lines.reduce((s, l) => s + l.price * l.quantity, 0), [lines]);
  const itemCount = useMemo(() => lines.reduce((s, l) => s + l.quantity, 0), [lines]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (activeCategory && p.category_id !== activeCategory) return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || (p.sku ?? '').toLowerCase().includes(q) || (p.barcode ?? '').toLowerCase().includes(q);
    });
  }, [products, search, activeCategory]);

  const countFor = useCallback((catId: string | null) =>
    products.filter((p) => catId === null || p.category_id === catId).length, [products]);

  const addLine = useCallback((line: Omit<BasketLine, 'key' | 'quantity'>, qty = 1) => {
    setLines((prev) => {
      const key = `${line.productId}:${line.variantId ?? ''}`;
      const idx = prev.findIndex((l) => l.key === key);
      if (idx >= 0) { const next = [...prev]; next[idx] = { ...next[idx], quantity: next[idx].quantity + qty }; return next; }
      return [...prev, { ...line, key, quantity: qty }];
    });
  }, []);
  const addProduct = (p: Product) => addLine({ productId: p.id, variantId: null, name: p.name, price: Number(p.price) });
  const setQuantity = (key: string, q: number) => setLines((prev) => prev.map((l) => (l.key === key ? { ...l, quantity: q } : l)));
  const removeLine = (key: string) => setLines((prev) => prev.filter((l) => l.key !== key));

  async function onScan() {
    const code = search.trim();
    if (!code) return;
    try {
      const res = await api.get('/retail/lookup', { params: { code } });
      const { kind, product, variant } = res.data;
      if (kind === 'variant') addLine({ productId: product.id, variantId: variant.id, name: `${product.name} — ${variant.name || variant.sku}`, price: variant.price });
      else addLine({ productId: product.id, variantId: null, name: product.name, price: product.price });
      setSearch(''); searchRef.current?.focus();
    } catch {
      if (filtered.length === 1) { addProduct(filtered[0]); setSearch(''); }
    }
  }

  function holdSale() {
    if (lines.length === 0) return;
    setHeld((prev) => [{ id: crypto.randomUUID(), at: Date.now(), lines, total: subtotal }, ...prev]);
    setLines([]); toast.success('Sale held');
  }
  function resumeSale(id: string) {
    const sale = held.find((h) => h.id === id); if (!sale) return;
    if (lines.length > 0) setHeld((prev) => [{ id: crypto.randomUUID(), at: Date.now(), lines, total: subtotal }, ...prev.filter((h) => h.id !== id)]);
    else setHeld((prev) => prev.filter((h) => h.id !== id));
    setLines(sale.lines);
  }

  async function charge(tender: 'cash' | 'manual_card') {
    const res = await api.post('/retail/checkout', {
      lines: lines.map((l) => ({ product_id: l.productId, variant_id: l.variantId, quantity: l.quantity })),
      tender: { adapter: tender, method: tender === 'cash' ? 'cash' : 'card' },
    });
    if (tender === 'cash') api.post('/retail/cash-drawer/open').catch(() => {});
    return { total: res.data.bill?.total ?? subtotal, paymentState: res.data.payment?.state ?? 'paid' };
  }

  return (
    <div className="flex h-full min-h-0 gap-4">
      {/* ── Catalogue ─────────────────────────────────────────────── */}
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-hairline bg-card shadow-sm">
        {/* search + scan */}
        <div className="flex items-center gap-3 border-b border-hairline p-4">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-4 top-1/2 size-[18px] -translate-y-1/2 text-text-subtle" />
            <input
              ref={searchRef} autoFocus value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') onScan(); }}
              placeholder="Search the menu, or scan a barcode…"
              className="h-12 w-full rounded-xl border border-hairline bg-surface pl-11 pr-4 text-[15px] font-medium outline-none transition-colors placeholder:text-text-subtle placeholder:font-normal focus:border-input"
            />
          </div>
          <button
            onClick={onScan} disabled={!search.trim()}
            className="inline-flex h-12 items-center gap-2 rounded-xl border border-hairline bg-surface px-4 text-sm font-semibold transition-colors hover:bg-hover disabled:opacity-40"
          >
            <ScanLine className="size-[18px]" /> Add
          </button>
        </div>

        {/* category chips */}
        <div className="flex gap-2.5 overflow-x-auto border-b border-hairline bg-card p-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Chip label="Everything" count={countFor(null)} active={activeCategory === null} onClick={() => setActiveCategory(null)} />
          {categories.map((c) => (
            <Chip key={c.id} label={c.name} count={countFor(c.id)} active={activeCategory === c.id} onClick={() => setActiveCategory(c.id)} />
          ))}
        </div>

        {/* grid */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {Array.from({ length: 10 }).map((_, i) => <div key={i} className="h-[196px] animate-pulse rounded-[18px] border border-hairline bg-surface-sunken" />)}
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
              <p className="text-base font-bold text-foreground">Nothing matches that</p>
              <p className="text-sm text-text-subtle">Try a different word, or clear the search.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
              {filtered.map((p) => (
                <Tile key={p.id} product={p} tint={tintFor(p.category_id)} inBasket={lines.find((l) => l.productId === p.id && !l.variantId)?.quantity ?? 0} fmt={fmt} onSelect={() => addProduct(p)} />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── Order panel ───────────────────────────────────────────── */}
      <aside className="flex w-[380px] shrink-0 flex-col overflow-hidden rounded-2xl border border-hairline bg-card shadow-sm xl:w-[420px]">
        <div className="flex items-start justify-between gap-3 border-b border-hairline p-5">
          <div>
            <h2 className="text-lg font-bold leading-tight">Current sale</h2>
            <p className="text-sm text-text-subtle">{itemCount > 0 ? `${itemCount} item${itemCount === 1 ? '' : 's'}` : 'Counter sale'}</p>
          </div>
          <div className="flex items-center gap-1">
            {held.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-hairline px-3 text-sm font-semibold transition-colors hover:bg-hover">
                    <Play className="size-4" /><span className="tabular-nums">{held.length}</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuLabel>Held sales</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {held.map((h) => (
                    <DropdownMenuItem key={h.id} onClick={() => resumeSale(h.id)} className="flex items-center justify-between gap-3">
                      <span className="text-sm">{h.lines.reduce((s, l) => s + l.quantity, 0)} items · {new Date(h.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      <span className="font-semibold tabular-nums">{fmt(h.total)}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {lines.length > 0 && (
              <button onClick={() => setLines([])} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-hairline px-3 text-sm font-semibold text-muted-foreground transition-colors hover:bg-hover hover:text-foreground">
                <Trash2 className="size-4" /> Clear
              </button>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {lines.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
              <span className="flex size-14 items-center justify-center rounded-2xl bg-surface-sunken text-text-subtle"><ShoppingBag className="size-7" /></span>
              <div>
                <p className="font-bold text-foreground">Nothing on this order yet</p>
                <p className="mt-0.5 text-sm text-text-subtle">Tap anything on the menu to start.</p>
              </div>
            </div>
          ) : (
            <ul className="divide-y divide-hairline">
              {lines.map((l) => {
                const p = products.find((x) => x.id === l.productId);
                const tint = tintFor(p?.category_id ?? null);
                return (
                  <li key={l.key} className="flex items-center gap-3 p-4">
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-xl text-sm font-bold" style={{ background: tint.bg, color: tint.fg }}>
                      {l.name.substring(0, 2).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{l.name}</p>
                      <p className="text-xs text-text-subtle tabular-nums">{fmt(l.price)} each</p>
                    </div>
                    <Stepper value={l.quantity} onChange={(q) => setQuantity(l.key, q)} onRemove={() => removeLine(l.key)} />
                    <span className="w-16 shrink-0 text-right text-sm font-bold tabular-nums">{fmt(l.price * l.quantity)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="border-t border-hairline p-5">
          <div className="mb-4 space-y-2">
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Subtotal</span><span className="tabular-nums">{fmt(subtotal)}</span>
            </div>
            <div className="flex items-center justify-between border-t border-hairline pt-2">
              <span className="text-base font-bold">Total</span>
              <span className="text-2xl font-bold tracking-tight tabular-nums">{fmt(subtotal)}</span>
            </div>
          </div>
          <div className="flex gap-2.5">
            <button onClick={holdSale} disabled={lines.length === 0} className="inline-flex h-14 items-center gap-2 rounded-xl border border-hairline px-5 text-sm font-semibold transition-colors hover:bg-hover disabled:opacity-40">
              <Pause className="size-4" /> Hold
            </button>
            <button
              onClick={() => { setPaySession((k) => k + 1); setPayOpen(true); }}
              disabled={lines.length === 0}
              className="inline-flex h-14 flex-1 items-center justify-center gap-2 rounded-xl bg-primary text-base font-bold text-primary-foreground shadow-sm transition-all hover:bg-brand-strong active:scale-[0.99] disabled:opacity-40"
            >
              Charge {fmt(subtotal)}
            </button>
          </div>
        </div>
      </aside>

      <PaymentDialog key={paySession} open={payOpen} onOpenChange={setPayOpen} total={subtotal} itemCount={itemCount} onCharge={charge} onComplete={() => { setLines([]); searchRef.current?.focus(); }} />
    </div>
  );
}

function Chip({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex h-12 shrink-0 items-center gap-2.5 rounded-[13px] border px-[18px] text-[15px] font-semibold transition-colors active:scale-[0.97]',
        active ? 'border-foreground bg-foreground text-background' : 'border-hairline bg-card text-foreground hover:bg-hover'
      )}
    >
      {label}
      <span className={cn('rounded-full px-2 py-0.5 text-[11.5px] font-bold tabular-nums', active ? 'bg-white/20 text-white' : 'bg-background text-muted-foreground')}>{count}</span>
    </button>
  );
}

function Tile({ product, tint, inBasket, fmt, onSelect }: {
  product: Product; tint: { bg: string; fg: string }; inBasket: number;
  fmt: (n: number) => string; onSelect: () => void;
}) {
  const tracks = Boolean(product.track_inventory);
  const stock = product.stock_quantity ?? null;
  const out = tracks && stock !== null && stock <= 0;
  const low = tracks && stock !== null && !out && product.low_stock_threshold != null && stock <= product.low_stock_threshold;
  const imgSrc = product.has_image ? `${api.defaults.baseURL}/products/${product.id}/image?t=${product.updated_at ? parseDbTimestamp(product.updated_at).getTime() : 0}` : null;

  return (
    <button
      type="button" onClick={onSelect} disabled={out}
      className={cn(
        'group relative flex flex-col rounded-[18px] border border-hairline bg-card p-[11px] text-left transition-all',
        'hover:border-border-strong hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        out && 'cursor-not-allowed opacity-45'
      )}
    >
      {(out || low) && (
        <span className={cn('absolute left-2.5 top-2.5 z-10 rounded-full px-2 py-[3px] text-[10px] font-bold', out ? 'bg-hover text-muted-foreground' : 'bg-warning-tint text-[#8A5B00]')}>
          {out ? 'Sold out' : 'Low stock'}
        </span>
      )}
      {inBasket > 0 && (
        <span className="absolute right-2.5 top-2.5 z-10 flex size-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground shadow-sm">{inBasket}</span>
      )}

      {/* art */}
      <span className="relative mb-[11px] flex h-[106px] w-full items-center justify-center overflow-hidden rounded-xl" style={{ background: tint.bg }}>
        <span className="pointer-events-none absolute inset-0" style={{ background: 'radial-gradient(circle at 50% 38%, rgba(255,255,255,.75), transparent 62%)' }} />
        {imgSrc ? (
          <img src={imgSrc} alt={product.name} loading="lazy" className="absolute inset-0 h-full w-full object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        ) : (
          <span className="relative text-3xl font-extrabold tracking-tight" style={{ color: tint.fg, opacity: 0.9 }}>
            {product.name.substring(0, 2).toUpperCase()}
          </span>
        )}
      </span>

      <span className="mb-1 block min-h-[35px] text-sm font-semibold leading-[1.25]">{product.name}</span>
      <span className="flex items-center gap-2">
        <span className="text-[15.5px] font-bold tracking-[-0.02em] tabular-nums">{fmt(Number(product.price))}</span>
        {tracks && stock !== null && !out && (
          <span className="ml-auto rounded-full bg-surface-sunken px-[7px] py-[2px] text-[10.5px] font-bold text-muted-foreground tabular-nums">{stock} left</span>
        )}
      </span>
    </button>
  );
}

function Stepper({ value, onChange, onRemove }: { value: number; onChange: (n: number) => void; onRemove: () => void }) {
  return (
    <div className="inline-flex items-center rounded-lg border border-hairline">
      <button aria-label="Decrease" onClick={() => (value <= 1 ? onRemove() : onChange(value - 1))} className="flex size-8 items-center justify-center rounded-l-lg text-muted-foreground transition-colors hover:bg-hover hover:text-foreground">
        {value <= 1 ? <X className="size-3.5" /> : <Minus className="size-3.5" />}
      </button>
      <span className="w-7 text-center text-sm font-bold tabular-nums">{value}</span>
      <button aria-label="Increase" onClick={() => onChange(value + 1)} className="flex size-8 items-center justify-center rounded-r-lg text-muted-foreground transition-colors hover:bg-hover hover:text-foreground">
        <Plus className="size-3.5" />
      </button>
    </div>
  );
}
