/**
 * Plemmo text wordmark (design system — docs/DESIGN_SYSTEM.md). Replaces the
 * inherited "Flo" cursive logo image (public/logo.svg/png) on entry screens.
 * No graphic brand mark was supplied with the design reference, so this is a
 * typographic wordmark in the Plemmo palette rather than a fabricated logo.
 */

export default function BrandWordmark({ className = '' }: { className?: string }) {
  return (
    <div className={`inline-flex items-center gap-2 ${className}`}>
      <span
        aria-hidden
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-primary text-base font-bold text-primary-foreground"
      >
        P
      </span>
      <span className="text-2xl font-bold tracking-tight text-foreground">Plemmo</span>
    </div>
  );
}
