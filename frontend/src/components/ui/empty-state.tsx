import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * EmptyState — the coherent "nothing here yet" surface. Always explains what
 * is missing and offers the next action, rather than leaving an unexplained
 * blank area. Used for empty tables, baskets, search results and lists.
 */
export interface EmptyStateProps extends React.ComponentProps<"div"> {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  compact?: boolean;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-2 py-8" : "gap-3 py-16",
        className
      )}
      {...props}
    >
      {icon && (
        <div className="flex size-12 items-center justify-center rounded-full bg-surface-sunken text-muted-foreground">
          {icon}
        </div>
      )}
      <div className="space-y-1">
        <p className="font-semibold text-foreground">{title}</p>
        {description && (
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
