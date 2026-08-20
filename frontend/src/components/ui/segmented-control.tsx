"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * SegmentedControl — a compact, single-select toggle used for mode switches
 * (e.g. Retail / Hospitality, Cash / Card, density modes). Keyboard-navigable
 * and touch-friendly. Prefer this over a row of buttons when the options are
 * mutually exclusive views of the same thing.
 */
export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md" | "lg";
  className?: string;
  "aria-label"?: string;
}

const sizeMap = {
  sm: "h-8 text-xs",
  md: "h-9 text-sm",
  lg: "h-11 text-sm",
};

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  className,
  ...aria
}: SegmentedControlProps<T>) {
  return (
    <div
      role="tablist"
      aria-label={aria["aria-label"]}
      className={cn(
        "inline-flex items-center gap-1 rounded-lg bg-surface-sunken p-1",
        className
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 font-medium transition-all",
              sizeMap[size],
              active
                ? "bg-surface text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
