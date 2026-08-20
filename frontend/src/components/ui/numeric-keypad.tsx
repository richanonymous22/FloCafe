"use client";

import * as React from "react";
import { Delete } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * NumericKeypad — the on-screen number pad the EPOS depends on so touchscreen
 * workflows never need a physical keyboard. Used for cash tender, quantity,
 * stock counts, price overrides and PIN entry.
 *
 * It edits a string `value` so leading zeros and an in-progress decimal are
 * preserved as the operator types. Callers parse to a number when they need
 * one. `mode="money"` shows a decimal key; `mode="integer"` hides it.
 */
export interface NumericKeypadProps {
  value: string;
  onChange: (next: string) => void;
  mode?: "money" | "integer";
  /** Quick-tender / preset chips shown above the pad (e.g. £5, £10, £20). */
  presets?: { label: string; value: string }[];
  onPreset?: (value: string) => void;
  maxLength?: number;
  className?: string;
}

const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

function Key({
  children,
  onClick,
  className,
  ariaLabel,
}: {
  children: React.ReactNode;
  onClick: () => void;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className={cn(
        "flex h-14 items-center justify-center rounded-lg border bg-surface text-xl font-semibold tabular-nums transition-colors hover:bg-secondary active:bg-accent active:text-accent-foreground select-none",
        className
      )}
    >
      {children}
    </button>
  );
}

export function NumericKeypad({
  value,
  onChange,
  mode = "money",
  presets,
  onPreset,
  maxLength = 12,
  className,
}: NumericKeypadProps) {
  const press = (k: string) => {
    if (value.length >= maxLength) return;
    if (k === "." && (mode !== "money" || value.includes("."))) return;
    // Prevent more than 2 decimal places in money mode.
    if (mode === "money" && value.includes(".")) {
      const dec = value.split(".")[1] ?? "";
      if (k !== "." && dec.length >= 2) return;
    }
    const next = value === "0" && k !== "." ? k : value + k;
    onChange(next);
  };
  const backspace = () => onChange(value.slice(0, -1));

  return (
    <div className={cn("space-y-2", className)}>
      {presets && presets.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {presets.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => onPreset?.(p.value)}
              className="h-10 rounded-lg border border-brand/25 bg-brand-soft text-sm font-semibold text-brand-strong transition-colors hover:bg-brand hover:text-white"
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div className="grid grid-cols-3 gap-2">
        {keys.map((k) => (
          <Key key={k} onClick={() => press(k)}>
            {k}
          </Key>
        ))}
        {mode === "money" ? (
          <Key onClick={() => press(".")} ariaLabel="Decimal point">
            .
          </Key>
        ) : (
          <span />
        )}
        <Key onClick={() => press("0")}>0</Key>
        <Key onClick={backspace} ariaLabel="Backspace" className="text-muted-foreground">
          <Delete className="size-5" />
        </Key>
      </div>
    </div>
  );
}
