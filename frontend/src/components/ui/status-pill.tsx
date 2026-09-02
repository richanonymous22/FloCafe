import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Status pill (docs/DESIGN_SYSTEM.md — "Pill / status badge"). Color-on-tint
 * with a leading dot, per the Serva reference. Use for order/payment/sync/
 * license/stock status everywhere instead of a one-off badge per screen.
 */
const statusPillVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-bold whitespace-nowrap [&>i]:size-1.5 [&>i]:rounded-full [&>i]:bg-current [&>i]:shrink-0",
  {
    variants: {
      tone: {
        success: "bg-plemmo-success-tint text-plemmo-success",
        warning: "bg-plemmo-warning-tint text-[#b8790a]",
        danger: "bg-plemmo-danger-tint text-plemmo-danger",
        info: "bg-plemmo-info-tint text-plemmo-info",
        accent: "bg-plemmo-accent-tint text-plemmo-accent",
        neutral: "bg-muted text-muted-foreground",
      },
    },
    defaultVariants: {
      tone: "neutral",
    },
  }
)

export interface StatusPillProps
  extends React.ComponentProps<"span">,
    VariantProps<typeof statusPillVariants> {
  /** Show the leading status dot. Default true. */
  dot?: boolean
}

function StatusPill({ className, tone, dot = true, children, ...props }: StatusPillProps) {
  return (
    <span data-slot="status-pill" className={cn(statusPillVariants({ tone }), className)} {...props}>
      {dot && <i aria-hidden />}
      {children}
    </span>
  )
}

export { StatusPill, statusPillVariants }
