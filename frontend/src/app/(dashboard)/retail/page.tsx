'use client';

/**
 * Plemmo retail till — the reference sell screen.
 *
 * A premium, touch-first counter-sale experience: catalogue (search / scan /
 * categories / product grid) on the left, a live basket and pay flow on the
 * right. Talks only to the retail + catalogue APIs — /products, /categories,
 * /retail/lookup, /retail/checkout, /retail/cash-drawer/open — and never
 * touches tables, kitchen stations or KDS.
 *
 * Scope note (backend gap, not faked here): the retail checkout endpoint
 * currently accepts lines + tender + customer only. Discounts, offers and
 * price overrides are therefore not yet wired into the till — closing that
 * gap needs a small, tested checkout change and is tracked in the rebuild
 * report rather than mocked in the UI.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Search,
  ScanLine,
  Trash2,
  Pause,
  Play,
  ShoppingBag,
  PackageSearch,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { QuantityStepper } from '@/components/ui/quantity-stepper';
import { ProductTile } from '@/components/ui/product-tile';
import { EmptyState } from '@/components/ui/empty-state';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PaymentDialog } from '@/components/retail/PaymentDialog';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import api from '@/lib/api';
import toast from 'react-hot-toast';

interface Product {
  id: string;
  category_id: string | null;
  name: string;
  price: number;
  sku: string | null;
  barcode: string | null;
  has_image?: boolean | number;
  updated_at?: string | null;
  track_inventory?: boolean | number;
  stock_quantity?: number | null;
  low_stock_threshold?: number | null;
}

interface Category {
  id: string;
  name: string;
}

interface BasketLine {
  key: string;
  productId: string;
  variantId: string | null;
  name: string;
  price: number;
  quantity: number;
}

interface HeldSale {
  id: string;
  at: number;
  lines: BasketLine[];
  total: number;
}

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
  const [paySession, setPaySession] = useState(0); // remounts PaymentDialog per sale
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
        setCategories((c.data.categories || []).map((cat: Category) => ({ id: cat.id, name: cat.name })));
      })
      .catch(() => {
        if (active) toast.error('Could not load the catalogue');
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const subtotal = useMemo(
    () => lines.reduce((sum, l) => sum + l.price * l.quantity, 0),
    [lines]
  );
  const itemCount = useMemo(
    () => lines.reduce((sum, l) => sum + l.quantity, 0),
    [lines]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (activeCategory && p.category_id !== activeCategory) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.sku ?? '').toLowerCase().includes(q) ||
        (p.barcode ?? '').toLowerCase().includes(q)
      );
    });
  }, [products, search, activeCategory]);

  const addLine = useCallback(
    (line: Omit<BasketLine, 'key' | 'quantity'>, qty = 1) => {
      setLines((prev) => {
        const key = `${line.productId}:${line.variantId ?? ''}`;
        const idx = prev.findIndex((l) => l.key === key);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = { ...next[idx], quantity: next[idx].quantity + qty };
          return next;
        }
        return [...prev, { ...line, key, quantity: qty }];
      });
    },
    []
  );

  const addProduct = (p: Product) =>
    addLine({ productId: p.id, variantId: null, name: p.name, price: Number(p.price) });

  const setQuantity = (key: string, quantity: number) =>
    setLines((prev) =>
      prev.map((l) => (l.key === key ? { ...l, quantity } : l))
    );
  const removeLine = (key: string) =>
    setLines((prev) => prev.filter((l) => l.key !== key));

  // Enter in the search/scan box: try an exact barcode/SKU lookup first (this
  // is the scan path — it resolves variants too); fall back to a single filtered
  // result; otherwise leave the grid filtered.
  async function onScan() {
    const code = search.trim();
    if (!code) return;
    try {
      const res = await api.get('/retail/lookup', { params: { code } });
      const { kind, product, variant } = res.data;
      if (kind === 'variant') {
        addLine({
          productId: product.id,
          variantId: variant.id,
          name: `${product.name} — ${variant.name || variant.sku}`,
          price: variant.price,
        });
      } else {
        addLine({ productId: product.id, variantId: null, name: product.name, price: product.price });
      }
      setSearch('');
      searchRef.current?.focus();
    } catch {
      if (filtered.length === 1) {
        addProduct(filtered[0]);
        setSearch('');
      }
      // else: no exact match and an ambiguous search — leave the grid filtered.
    }
  }

  function holdSale() {
    if (lines.length === 0) return;
    setHeld((prev) => [
      { id: crypto.randomUUID(), at: Date.now(), lines, total: subtotal },
      ...prev,
    ]);
    setLines([]);
    toast.success('Sale held');
  }
  function resumeSale(id: string) {
    const sale = held.find((h) => h.id === id);
    if (!sale) return;
    if (lines.length > 0) {
      setHeld((prev) => [
        { id: crypto.randomUUID(), at: Date.now(), lines, total: subtotal },
        ...prev.filter((h) => h.id !== id),
      ]);
    } else {
      setHeld((prev) => prev.filter((h) => h.id !== id));
    }
    setLines(sale.lines);
  }

  async function charge(tender: 'cash' | 'manual_card') {
    const res = await api.post('/retail/checkout', {
      lines: lines.map((l) => ({
        product_id: l.productId,
        variant_id: l.variantId,
        quantity: l.quantity,
      })),
      tender: { adapter: tender, method: tender === 'cash' ? 'cash' : 'card' },
    });
    if (tender === 'cash') {
      // Best-effort — no printer/drawer configured is a normal state.
      api.post('/retail/cash-drawer/open').catch(() => {});
    }
    return {
      total: res.data.bill?.total ?? subtotal,
      paymentState: res.data.payment?.state ?? 'paid',
    };
  }

  return (
    <div className="flex h-full min-h-0 gap-4">
      {/* ── Catalogue ─────────────────────────────────────────────── */}
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-surface">
        <div className="flex flex-col gap-3 border-b p-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onScan();
                }}
                placeholder="Search products, or scan a barcode…"
                className="h-11 pl-9 text-base"
              />
            </div>
            <Button
              variant="outline"
              size="lg"
              className="h-11 gap-2"
              onClick={onScan}
              disabled={!search.trim()}
            >
              <ScanLine className="size-4" />
              <span className="hidden sm:inline">Add</span>
            </Button>
          </div>

          {categories.length > 0 && (
            <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
              <CategoryChip
                label="All"
                active={activeCategory === null}
                onClick={() => setActiveCategory(null)}
              />
              {categories.map((c) => (
                <CategoryChip
                  key={c.id}
                  label={c.name}
                  active={activeCategory === c.id}
                  onClick={() => setActiveCategory(c.id)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loading ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {Array.from({ length: 12 }).map((_, i) => (
                <div
                  key={i}
                  className="aspect-[3/4] animate-pulse rounded-xl border bg-surface-sunken"
                />
              ))}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={<PackageSearch className="size-6" />}
              title={search ? 'No matching products' : 'No products yet'}
              description={
                search
                  ? 'Try a different search term, or scan the barcode.'
                  : 'Add products in the catalogue to start selling.'
              }
            />
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {filtered.map((p) => (
                <ProductTile
                  key={p.id}
                  product={p}
                  formatPrice={fmt}
                  inBasketQty={
                    lines.find((l) => l.productId === p.id && !l.variantId)?.quantity ?? 0
                  }
                  onSelect={() => addProduct(p)}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── Basket ────────────────────────────────────────────────── */}
      <aside className="flex w-[360px] shrink-0 flex-col overflow-hidden rounded-xl border bg-surface xl:w-[400px]">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <ShoppingBag className="size-4 text-muted-foreground" />
            <h2 className="font-semibold">Current sale</h2>
            {itemCount > 0 && (
              <span className="rounded-full bg-brand-soft px-2 py-0.5 text-xs font-semibold tabular-nums text-brand-strong">
                {itemCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {held.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="gap-1.5">
                    <Play className="size-4" />
                    <span className="tabular-nums">{held.length}</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuLabel>Held sales</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {held.map((h) => (
                    <DropdownMenuItem
                      key={h.id}
                      onClick={() => resumeSale(h.id)}
                      className="flex items-center justify-between gap-3"
                    >
                      <span className="text-sm">
                        {h.lines.reduce((s, l) => s + l.quantity, 0)} items ·{' '}
                        {new Date(h.at).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      <span className="font-semibold tabular-nums">{fmt(h.total)}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {lines.length > 0 && (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Clear sale"
                onClick={() => setLines([])}
              >
                <Trash2 className="size-4" />
              </Button>
            )}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {lines.length === 0 ? (
            <EmptyState
              icon={<ShoppingBag className="size-6" />}
              title="Basket is empty"
              description="Scan or tap a product to add it to the sale."
              compact
              className="h-full"
            />
          ) : (
            <ul className="divide-y">
              {lines.map((l) => (
                <li key={l.key} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{l.name}</p>
                    <p className="text-xs tabular-nums text-muted-foreground">
                      {fmt(l.price)} each
                    </p>
                  </div>
                  <QuantityStepper
                    size="sm"
                    value={l.quantity}
                    onChange={(q) => setQuantity(l.key, q)}
                    onRemove={() => removeLine(l.key)}
                  />
                  <span className="w-16 shrink-0 text-right text-sm font-semibold tabular-nums">
                    {fmt(l.price * l.quantity)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t bg-surface-sunken p-4">
          <div className="mb-3 space-y-1.5">
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span>Subtotal</span>
              <span className="tabular-nums">{fmt(subtotal)}</span>
            </div>
            <div className="flex items-center justify-between text-lg font-bold">
              <span>Total</span>
              <span className="tabular-nums">{fmt(subtotal)}</span>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="lg"
              className="h-14 gap-2"
              disabled={lines.length === 0}
              onClick={holdSale}
            >
              <Pause className="size-4" />
              Hold
            </Button>
            <Button
              size="lg"
              className="h-14 flex-1 text-base"
              disabled={lines.length === 0}
              onClick={() => {
                setPaySession((k) => k + 1);
                setPayOpen(true);
              }}
            >
              Charge {fmt(subtotal)}
            </Button>
          </div>
        </div>
      </aside>

      <PaymentDialog
        key={paySession}
        open={payOpen}
        onOpenChange={setPayOpen}
        total={subtotal}
        itemCount={itemCount}
        onCharge={charge}
        onComplete={() => {
          setLines([]);
          searchRef.current?.focus();
        }}
      />
    </div>
  );
}

function CategoryChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors ${
        active
          ? 'border-brand bg-brand text-white'
          : 'border-border bg-surface text-muted-foreground hover:bg-secondary hover:text-foreground'
      }`}
    >
      {label}
    </button>
  );
}
