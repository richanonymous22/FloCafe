'use client';

import { X } from 'lucide-react';
import type { Table } from '@/lib/types';
import { useHeldOrdersStore } from '@/store/held-orders';
import { useI18n } from '@/hooks/useI18n';

interface Props {
  tables: Table[];
  selectedTableId: string | null;
  onSelectAvailable: (tableId: string, customer?: { id: number; name: string; phone: string } | null) => void;
  onSelectOccupied: (table: Table) => void;
  onSelectHeld: (tableId: string) => void;
  onPlaceOrder: () => void;
  onHoldTable: (tableId: string) => void;
  onClose: () => void;
}

const statusStyles: Record<string, { border: string; badge: string; badgeKey: string | null }> = {
  available: { border: 'border-border hover:border-brand/40', badge: '', badgeKey: null },
  occupied: { border: 'border-orange-300 bg-orange-50', badge: 'bg-orange-500', badgeKey: 'pos.tableOccupied' },
  reserved: { border: 'border-yellow-300 bg-yellow-50', badge: 'bg-yellow-500', badgeKey: 'pos.tableReserved' },
  cleaning: { border: 'border-border-strong bg-secondary', badge: 'bg-surface-sunken0', badgeKey: 'pos.tableCleaning' },
  held: { border: 'border-blue-400 bg-blue-50', badge: 'bg-blue-500', badgeKey: 'pos.tableHeld' },
};

export default function TablePickerModal({
  tables, selectedTableId, onSelectAvailable, onSelectOccupied, onSelectHeld, onPlaceOrder, onHoldTable, onClose,
}: Props) {
  const heldOrders = useHeldOrdersStore();
  const { t } = useI18n();

  const handleClick = (table: Table) => {
    if (heldOrders.hasHeldOrder(table.id)) {
      onSelectHeld(table.id);
      return;
    }
    if (table.status === 'occupied') {
      onSelectOccupied(table);
      return;
    }
    if (table.status === 'available' || table.status === 'reserved') {
      const customer = table.status === 'reserved' && table.reservation_customer_id
        ? { id: table.reservation_customer_id, name: table.reservation_customer_name ?? '', phone: table.reservation_customer_phone ?? '' }
        : null;
      onSelectAvailable(table.id, customer);
      return;
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-surface rounded-2xl p-6 w-full max-w-lg max-h-[80vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold">{t('pos.selectTable')}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-muted-foreground">
            <X size={20} />
          </button>
        </div>

        <div className="grid grid-cols-3 gap-3">
          {tables.map((table) => {
            const isHeld = heldOrders.hasHeldOrder(table.id);
            const isSelected = selectedTableId === table.id;
            const style = statusStyles[table.status] || statusStyles.available;
            const isDisabled = table.status === 'cleaning';

            return (
              <button
                key={table.id}
                onClick={() => !isDisabled && handleClick(table)}
                disabled={isDisabled}
                className={`p-4 rounded-xl border-2 text-center transition-colors relative ${
                  isSelected
                    ? 'border-brand bg-brand-light'
                    : isHeld
                      ? 'border-blue-400 bg-blue-50'
                      : style.border
                } ${isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                {isHeld && (
                  <span className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] px-1.5 py-0.5 rounded-full font-bold">
                    {t('pos.tableHeld')}
                  </span>
                )}
                {!isHeld && style.badgeKey && (
                  <span className={`absolute -top-2 -right-2 ${style.badge} text-white text-[10px] px-1.5 py-0.5 rounded-full font-bold`}>
                    {t(style.badgeKey)}
                  </span>
                )}
                <p className="font-bold text-foreground">{table.name}</p>
                <p className="text-xs text-muted-foreground">{t('pos.tableSeats', { count: table.capacity })}</p>
                {table.status === 'occupied' && (table.current_order || table.activeOrder) && (
                  <p className="text-xs text-orange-600 font-medium mt-1">
                    #{(table.current_order || table.activeOrder)?.order_number}
                  </p>
                )}
              </button>
            );
          })}
        </div>

        {tables.length === 0 && (
          <p className="text-center text-muted-foreground py-8">{t('pos.noTablesFound')}</p>
        )}

        {selectedTableId && (
          <div className="flex gap-3 mt-4 pt-4 border-t border-hairline">
            <button
              onClick={() => onHoldTable(selectedTableId)}
              className="flex-1 px-4 py-3 rounded-xl border-2 border-border text-foreground font-medium hover:bg-surface-sunken transition-colors"
            >
              {t('pos.holdTable')}
            </button>
            <button
              onClick={() => {
                onPlaceOrder();
                onClose();
              }}
              className="flex-1 px-4 py-3 rounded-xl bg-brand text-white font-medium hover:bg-brand/90 transition-colors"
            >
              {t('pos.placeOrderButton')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
