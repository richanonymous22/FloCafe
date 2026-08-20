"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { nameToColor } from "@/lib/image-utils";
import { parseDbTimestamp } from "@/lib/utils";
import api from "@/lib/api";

/**
 * ProductTile — a restrained, fast catalogue tile for the till product grid.
 * Image with an initials fallback (never a blank flash), name, price, an
 * optional in-basket count badge and a low/out-of-stock marker. Deliberately
 * under-decorated: the cashier reads the grid at a glance.
 */
export interface ProductTileProduct {
  id: string;
  name: string;
  price: number;
  has_image?: boolean | number;
  updated_at?: string | null;
  track_inventory?: boolean | number;
  stock_quantity?: number | null;
  low_stock_threshold?: number | null;
}

export interface ProductTileProps {
  product: ProductTileProduct;
  onSelect: () => void;
  inBasketQty?: number;
  showImage?: boolean;
  formatPrice: (value: number) => string;
  className?: string;
}

export function ProductTile({
  product,
  onSelect,
  inBasketQty = 0,
  showImage = true,
  formatPrice,
  className,
}: ProductTileProps) {
  const tracks = Boolean(product.track_inventory);
  const stock = product.stock_quantity ?? null;
  const outOfStock = tracks && stock !== null && stock <= 0;
  const lowStock =
    tracks &&
    stock !== null &&
    !outOfStock &&
    product.low_stock_threshold != null &&
    stock <= product.low_stock_threshold;

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={outOfStock}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-xl border bg-surface p-2.5 text-left transition-all",
        "hover:border-brand/40 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50",
        "active:scale-[0.98]",
        outOfStock && "cursor-not-allowed opacity-55",
        className
      )}
    >
      {inBasketQty > 0 && (
        <span className="absolute right-0 top-0 z-10 flex min-w-6 items-center justify-center rounded-bl-lg bg-brand px-1.5 py-0.5 text-xs font-bold tabular-nums text-white">
          {inBasketQty}
        </span>
      )}
      {(outOfStock || lowStock) && (
        <span
          className={cn(
            "absolute left-2 top-2 z-10 rounded-full px-2 py-0.5 text-[10px] font-semibold",
            outOfStock
              ? "bg-danger-tint text-destructive"
              : "bg-warning-tint text-warning-foreground"
          )}
        >
          {outOfStock ? "Out of stock" : "Low"}
        </span>
      )}

      {showImage && (
        <div className="relative mb-2 aspect-square w-full overflow-hidden rounded-lg">
          <div
            className="absolute inset-0 flex items-center justify-center"
            style={{ backgroundColor: nameToColor(product.name) }}
          >
            <span className="text-2xl font-bold text-white/85">
              {product.name.substring(0, 2).toUpperCase()}
            </span>
          </div>
          {Boolean(product.has_image) && (
            <img
              src={`${api.defaults.baseURL}/products/${product.id}/image?t=${
                product.updated_at ? parseDbTimestamp(product.updated_at).getTime() : 0
              }`}
              alt={product.name}
              loading="lazy"
              className="absolute inset-0 h-full w-full object-cover"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          )}
        </div>
      )}

      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-sm font-medium leading-snug text-foreground">
          {product.name}
        </p>
      </div>
      <div className="mt-1 flex items-center justify-between">
        <span className="font-semibold tabular-nums text-foreground">
          {formatPrice(Number(product.price))}
        </span>
        {tracks && stock !== null && !outOfStock && (
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {stock} in stock
          </span>
        )}
      </div>
    </button>
  );
}
