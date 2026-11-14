import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface Item {
  id: string;
  code: string;
  name: string;
  description: string;
  type: 'STOCK' | 'SERVICE' | 'NON_STOCK';
  category: string;
  unit: string;
  /** KRA eTIMS item classification code. */
  etimsClassCode?: string;
  inventoryAccountId: string | null;
  cogsAccountId: string | null;
  salesAccountId: string | null;
  purchaseAccountId: string | null;
  salesTaxCodeId: string | null;
  purchaseTaxCodeId: string | null;
  salesPrice: string | null;
  reorderLevel: string | null;
  reorderQty?: string | null;
  valuation?: 'AVERAGE' | 'FIFO' | 'LIFO';
  categoryId?: string | null;
  barcode?: string | null;
  /** Selling prices in other currencies. */
  prices?: { currency: string; price: string }[];
  tracking?: 'NONE' | 'BATCH' | 'SERIAL';
  trackExpiry?: boolean;
  lastPurchase?: { currency: string; unitPrice: string; date: string } | null;
  isActive: boolean;
}
export interface Warehouse {
  id: string;
  entityId: string;
  branchId: string;
  code: string;
  name: string;
  isActive: boolean;
}

export function useItems() {
  return useQuery({ queryKey: ['items'], queryFn: () => api.get<Item[]>('/items'), staleTime: 30_000 });
}
export function useWarehouses() {
  return useQuery({ queryKey: ['warehouses'], queryFn: () => api.get<Warehouse[]>('/warehouses'), staleTime: 60_000 });
}
