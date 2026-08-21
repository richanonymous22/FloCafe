import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * PageHeader — the editorial page masthead. A small-caps eyebrow, a serif
 * display title, an optional lede, and a right-aligned action cluster. This is
 * the signature that makes every back-office screen read as one designed
 * product rather than a stack of forms.
 */
export interface PageHeaderProps {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        "flex flex-col gap-4 pb-6 sm:flex-row sm:items-end sm:justify-between",
        className
      )}
    >
      <div className="min-w-0 space-y-1.5">
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1 className="text-display-lg text-3xl text-foreground sm:text-4xl">
          {title}
        </h1>
        {description && (
          <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </header>
  );
}

/**
 * PageContainer — the comfortable back-office content column: generous
 * gutters and a max measure so editorial pages breathe. Full-bleed till and
 * KDS surfaces opt out and manage their own layout.
 */
export function PageContainer({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("mx-auto w-full max-w-[1400px] px-1 py-2", className)}>
      {children}
    </div>
  );
}

/**
 * SectionLabel — a standalone small-caps section divider label for grouping
 * within a page.
 */
export function SectionLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <p className={cn("eyebrow mb-3", className)}>{children}</p>;
}
