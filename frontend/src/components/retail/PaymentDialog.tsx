"use client";

import { useState } from "react";
import { Banknote, CreditCard, Check, Loader2, AlertCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { NumericKeypad } from "@/components/ui/numeric-keypad";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useFormatCurrency } from "@/hooks/useFormatCurrency";
import { useAuthStore } from "@/store/auth";
import { getCurrencySymbol } from "@/lib/countries";

type Tender = "cash" | "manual_card";
type Stage = "tender" | "processing" | "done";

export interface PaymentResult {
  total: number;
  change: number;
  paymentState: string;
}

export interface PaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  total: number;
  itemCount: number;
  /** Runs the real checkout. Returns the settled total and payment state. */
  onCharge: (tender: Tender) => Promise<{ total: number; paymentState: string }>;
  /** Called after the operator dismisses a completed sale. */
  onComplete: () => void;
}

export function PaymentDialog({
  open,
  onOpenChange,
  total,
  itemCount,
  onCharge,
  onComplete,
}: PaymentDialogProps) {
  const fmt = useFormatCurrency();
  const currency = useAuthStore((s) => s.currentTenant?.currency ?? "GBP");
  const symbol = getCurrencySymbol(currency);

  const [tender, setTender] = useState<Tender>("cash");
  const [cashGiven, setCashGiven] = useState("");
  const [stage, setStage] = useState<Stage>("tender");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PaymentResult | null>(null);

  // State resets per sale via a remount key from the parent (see RetailTillPage),
  // so no open-effect is needed — initial state below is already a fresh sale.
  const cashValue = parseFloat(cashGiven || "0") || 0;
  const change = tender === "cash" ? Math.max(0, cashValue - total) : 0;
  const shortfall = tender === "cash" ? Math.max(0, total - cashValue) : 0;
  const canCharge =
    stage === "tender" && (tender === "manual_card" || cashValue >= total);

  const presets = [5, 10, 20, 50].map((v) => ({
    label: `${symbol}${v}`,
    value: String(v),
  }));

  async function charge() {
    setError(null);
    setStage("processing");
    try {
      const res = await onCharge(tender);
      const settled = res.total ?? total;
      setResult({
        total: settled,
        change: tender === "cash" ? Math.max(0, cashValue - settled) : 0,
        paymentState: res.paymentState,
      });
      setStage("done");
    } catch (err: unknown) {
      const message =
        (err as { response?: { data?: { error?: string } } })?.response?.data
          ?.error || "Payment could not be completed. Please try again.";
      setError(message);
      setStage("tender");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (stage === "processing" ? null : onOpenChange(o))}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0" data-density="touch">
        {stage === "done" && result ? (
          <div className="flex flex-col items-center gap-4 p-8 text-center">
            <div className="flex size-16 items-center justify-center rounded-full bg-success-tint text-success">
              <Check className="size-8" />
            </div>
            <div className="space-y-1">
              <DialogTitle className="text-xl">Payment complete</DialogTitle>
              <p className="text-sm capitalize text-muted-foreground">
                {result.paymentState} · {itemCount} item{itemCount === 1 ? "" : "s"}
              </p>
            </div>

            <div className="w-full space-y-2 rounded-xl border bg-surface-sunken p-4">
              <Row label="Total paid" value={fmt(result.total)} strong />
              {result.change > 0 && (
                <Row
                  label="Change due"
                  value={fmt(result.change)}
                  strong
                  accent="success"
                />
              )}
            </div>

            <Button
              size="lg"
              className="h-12 w-full text-base"
              onClick={() => {
                onOpenChange(false);
                onComplete();
              }}
            >
              New sale
            </Button>
          </div>
        ) : (
          <>
            <DialogHeader className="border-b px-6 py-4 text-left">
              <DialogTitle className="flex items-center justify-between text-base">
                <span>Take payment</span>
                <span className="text-2xl font-bold tabular-nums text-foreground">
                  {fmt(total)}
                </span>
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-4 p-6">
              <SegmentedControl<Tender>
                aria-label="Payment method"
                size="lg"
                value={tender}
                onChange={setTender}
                options={[
                  { value: "cash", label: "Cash", icon: <Banknote className="size-4" /> },
                  {
                    value: "manual_card",
                    label: "Card",
                    icon: <CreditCard className="size-4" />,
                  },
                ]}
              />

              {tender === "cash" ? (
                <div className="space-y-4">
                  <div className="flex items-end justify-between rounded-xl border bg-surface-sunken px-4 py-3">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Cash received
                      </p>
                      <p className="text-2xl font-semibold tabular-nums">
                        {symbol}
                        {cashGiven || "0"}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {shortfall > 0 ? "Remaining" : "Change"}
                      </p>
                      <p
                        className={`text-2xl font-semibold tabular-nums ${
                          shortfall > 0 ? "text-muted-foreground" : "text-success"
                        }`}
                      >
                        {fmt(shortfall > 0 ? shortfall : change)}
                      </p>
                    </div>
                  </div>

                  <NumericKeypad
                    mode="money"
                    value={cashGiven}
                    onChange={setCashGiven}
                    presets={presets}
                    onPreset={(v) => setCashGiven(v)}
                  />
                </div>
              ) : (
                <div className="rounded-xl border border-dashed bg-surface-sunken px-4 py-8 text-center">
                  <CreditCard className="mx-auto mb-2 size-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    Take {fmt(total)} on the card terminal, then confirm below to
                    record the sale.
                  </p>
                </div>
              )}

              {error && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-danger-tint px-3 py-2 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 size-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <Button
                size="lg"
                className="h-14 w-full text-base"
                disabled={!canCharge}
                onClick={charge}
              >
                {stage === "processing" ? (
                  <>
                    <Loader2 className="size-5 animate-spin" /> Processing…
                  </>
                ) : tender === "cash" ? (
                  `Tender ${fmt(cashValue || total)}`
                ) : (
                  `Confirm ${fmt(total)}`
                )}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Row({
  label,
  value,
  strong,
  accent,
}: {
  label: string;
  value: string;
  strong?: boolean;
  accent?: "success";
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span
        className={`tabular-nums ${strong ? "text-lg font-bold" : "text-sm"} ${
          accent === "success" ? "text-success" : "text-foreground"
        }`}
      >
        {value}
      </span>
    </div>
  );
}
