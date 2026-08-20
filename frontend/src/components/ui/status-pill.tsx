import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * StatusPill — a compact, semantic state indicator used across the Plemmo
 * shell and operational screens (sync state, licence state, stock state,
 * payment state). A tone + optional dot; never relies on colour alone — the
 * label carries the meaning.
 */
const pillVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full font-medium whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "bg-secondary text-secondary-foreground",
        brand: "bg-brand-soft text-brand-strong",
        success: "bg-success-tint text-success",
        warning: "bg-warning-tint text-warning-foreground",
        danger: "bg-danger-tint text-destructive",
        info: "bg-info-tint text-info",
      },
      size: {
        sm: "px-2 py-0.5 text-[11px]",
        md: "px-2.5 py-1 text-xs",
      },
    },
    defaultVariants: { tone: "neutral", size: "md" },
  }
);

const dotTone: Record<string, string> = {
  neutral: "bg-muted-foreground",
  brand: "bg-brand",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  info: "bg-info",
};

export interface StatusPillProps
  extends React.ComponentProps<"span">,
    VariantProps<typeof pillVariants> {
  dot?: boolean;
  pulse?: boolean;
}

export function StatusPill({
  className,
  tone = "neutral",
  size,
  dot = true,
  pulse = false,
  children,
  ...props
}: StatusPillProps) {
  return (
    <span className={cn(pillVariants({ tone, size }), className)} {...props}>
      {dot && (
        <span
          className={cn(
            "size-1.5 rounded-full",
            dotTone[tone ?? "neutral"],
            pulse && "animate-pulse-ring"
          )}
        />
      )}
      {children}
    </span>
  );
}
