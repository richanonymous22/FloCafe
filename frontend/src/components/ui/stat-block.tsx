import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * StatBlock (KPI) — a single headline metric with optional label, delta and
 * icon. The building block of mode-aware dashboards. Money and counts render
 * with tabular numerals so figures stay column-aligned across a row.
 */
export interface StatBlockProps extends React.ComponentProps<"div"> {
  label: string;
  value: React.ReactNode;
  sublabel?: React.ReactNode;
  icon?: React.ReactNode;
  delta?: { value: string; direction: "up" | "down" | "flat" };
  tone?: "default" | "success" | "warning" | "danger";
}

const toneAccent: Record<string, string> = {
  default: "text-foreground",
  success: "text-success",
  warning: "text-warning-foreground",
  danger: "text-destructive",
};

export function StatBlock({
  label,
  value,
  sublabel,
  icon,
  delta,
  tone = "default",
  className,
  ...props
}: StatBlockProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-xl border bg-surface p-4 shadow-xs",
        className
      )}
      {...props}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {icon && <span className="text-muted-foreground">{icon}</span>}
      </div>
      <div
        className={cn(
          "text-2xl font-semibold tabular-nums leading-tight",
          toneAccent[tone]
        )}
      >
        {value}
      </div>
      <div className="flex items-center gap-2">
        {delta && (
          <span
            className={cn(
              "text-xs font-medium tabular-nums",
              delta.direction === "up" && "text-success",
              delta.direction === "down" && "text-destructive",
              delta.direction === "flat" && "text-muted-foreground"
            )}
          >
            {delta.direction === "up" ? "▲" : delta.direction === "down" ? "▼" : "→"}{" "}
            {delta.value}
          </span>
        )}
        {sublabel && (
          <span className="text-xs text-muted-foreground">{sublabel}</span>
        )}
      </div>
    </div>
  );
}
