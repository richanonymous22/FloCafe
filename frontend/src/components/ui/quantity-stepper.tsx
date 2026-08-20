"use client";

import * as React from "react";
import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * QuantityStepper — decrement / value / increment. Used on basket lines,
 * stock counts and receiving. Touch-sized by default; hitting 0 on decrement
 * fires onRemove when supplied so callers can drop the line.
 */
export interface QuantityStepperProps {
  value: number;
  onChange: (next: number) => void;
  onRemove?: () => void;
  min?: number;
  max?: number;
  step?: number;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizeMap = {
  sm: { btn: "size-7", val: "w-8 text-sm", icon: "size-3.5" },
  md: { btn: "size-9", val: "w-10 text-base", icon: "size-4" },
  lg: { btn: "size-11", val: "w-12 text-lg", icon: "size-5" },
};

export function QuantityStepper({
  value,
  onChange,
  onRemove,
  min = 0,
  max = 9999,
  step = 1,
  size = "md",
  className,
}: QuantityStepperProps) {
  const s = sizeMap[size];
  const dec = () => {
    const next = value - step;
    if (next < min || next <= 0) {
      if (onRemove) return onRemove();
      onChange(Math.max(min, next));
      return;
    }
    onChange(next);
  };
  const inc = () => onChange(Math.min(max, value + step));

  return (
    <div
      className={cn(
        "inline-flex items-center rounded-lg border bg-surface",
        className
      )}
    >
      <button
        type="button"
        aria-label="Decrease quantity"
        onClick={dec}
        className={cn(
          "inline-flex items-center justify-center rounded-l-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground active:bg-secondary",
          s.btn
        )}
      >
        <Minus className={s.icon} />
      </button>
      <span
        className={cn(
          "text-center font-semibold tabular-nums select-none",
          s.val
        )}
      >
        {value}
      </span>
      <button
        type="button"
        aria-label="Increase quantity"
        onClick={inc}
        className={cn(
          "inline-flex items-center justify-center rounded-r-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground active:bg-secondary",
          s.btn
        )}
      >
        <Plus className={s.icon} />
      </button>
    </div>
  );
}
