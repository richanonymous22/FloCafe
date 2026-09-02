import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * KPI tile (docs/DESIGN_SYSTEM.md — "KPI tile"). A card variant for dashboard/
 * reports metrics: icon + label header, large numeric value, optional footer
 * (trend/comparison). Ported 1:1 from the Serva reference's `.kpi` pattern.
 */
export interface KpiTileProps extends React.ComponentProps<"div"> {
  label: string
  value: React.ReactNode
  icon?: React.ReactNode
  /** Icon chip background/foreground, e.g. "bg-plemmo-orange-tint text-plemmo-orange". */
  iconClassName?: string
  footer?: React.ReactNode
}

function KpiTile({ label, value, icon, iconClassName, footer, className, ...props }: KpiTileProps) {
  return (
    <div
      data-slot="kpi-tile"
      className={cn(
        "relative overflow-hidden rounded-[var(--radius-lg)] border border-border bg-card p-[18px] pb-3.5 shadow-[var(--plemmo-shadow)] transition-shadow duration-300 [transition-timing-function:var(--plemmo-ease)] hover:shadow-[var(--plemmo-shadow-md)] hover:border-[var(--plemmo-line-2)]",
        className
      )}
      {...props}
    >
      <div className="mb-3.5 flex items-center gap-2.5">
        {icon && (
          <span className={cn("flex size-[30px] shrink-0 items-center justify-center rounded-[9px] [&>svg]:size-[15px]", iconClassName)}>
            {icon}
          </span>
        )}
        <span className="text-[12.5px] font-medium text-muted-foreground">{label}</span>
      </div>
      <div className="text-[27px] font-bold leading-none tracking-[-.035em] text-foreground">{value}</div>
      {footer && (
        <div className="mt-3 flex items-center justify-between gap-2.5 text-[11px] text-muted-foreground/70">
          {footer}
        </div>
      )}
    </div>
  )
}

export { KpiTile }
