export type { Page } from '@/lib/types';

export interface Zone {
  id: string;
  code: string;
  name: string;
  type: 'ZONE' | 'DMA';
  parentId: string | null;
  active: boolean;
}

export interface TariffBlock {
  upTo: string | null;
  rate: string;
  fixedAmount: string | null;
}

export interface Tariff {
  id: string;
  code: string;
  name: string;
  category: string;
  effectiveFrom: string;
  approvalReference?: string;
  blocks: TariffBlock[];
  meterRent: string;
  sewerPercent: string;
  minimumCharge: string;
  defaultEstimate: string;
  active: boolean;
}

export interface Customer {
  id: string;
  accountNo: string;
  name: string;
  category: string;
  idType?: string;
  idNumber?: string;
  kraPin?: string;
  phone?: string;
  altPhone?: string;
  email?: string;
  postalAddress?: string;
  zoneId: string;
  location?: string;
  plotNo?: string;
  gps?: { lat: number; lng: number } | null;
  tariffId: string;
  sewered: boolean;
  status: string;
  connectionDate?: string;
  meterId: string | null;
  balance: string;
  oldestUnpaidDueDate: string | null;
  notes?: string;
}

export interface Meter {
  id: string;
  serialNo: string;
  make?: string;
  sizeMm: number;
  dials: number;
  type: 'CUSTOMER' | 'BULK' | 'PRODUCTION';
  status: string;
  customerId: string | null;
  zoneId: string | null;
  installedAt?: string;
  lastReading: string;
  lastReadingDate?: string;
  calibrationDue?: string;
  customer?: { id: string; accountNo: string; name: string } | null;
  tests?: MeterTestRecord[];
  lastTest?: MeterTestRecord | null;
}

export interface MeterTestRecord {
  at: string;
  result: 'PASS' | 'FAIL';
  errorPercent?: string;
  certificateNo?: string;
  testedBy?: string;
  note?: string;
}

export interface Reading {
  id: string;
  period: string;
  meterId: string;
  customerId: string | null;
  previousValue: string;
  value: string | null;
  registerUnits: string;
  units: string;
  type: string;
  exception: string;
  status: string;
  readAt: string;
  gps?: { lat: number; lng: number; accuracy?: number };
  photoId: string | null;
  note?: string;
  meterSerial?: string | null;
  customer?: { id: string; accountNo: string; name: string } | null;
  readerName?: string | null;
}

export interface BillLine {
  code: string;
  description: string;
  quantity: string;
  rate: string | null;
  amount: string;
}

export interface Bill {
  id: string;
  billNo: string | null;
  billRunId: string;
  customerId: string;
  accountNo: string;
  customerName: string;
  period: string;
  status: string;
  meterSerial?: string | null;
  previousReading: string | null;
  currentReading: string | null;
  units: string;
  estimated: boolean;
  tariffCode: string;
  lines: BillLine[];
  currentCharges: string;
  balanceBroughtForward: string;
  amountDue: string;
  billDate: string;
  dueDate: string;
}

export interface SyncState {
  status: 'NOT_SENT' | 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';
  journalId?: string;
  error?: string;
}

export interface BillRun {
  id: string;
  period: string;
  kind?: 'REGULAR' | 'SUPPLEMENTARY';
  customerId?: string | null;
  reason?: string;
  zoneId: string | null;
  status: string;
  billDate: string;
  dueDate: string;
  billCount: number;
  totalUnits: string;
  totalAmount: string;
  totals: Record<string, string>;
  createdBy: string;
  approvedAt?: string;
  accounting: SyncState;
}

export interface Payment {
  id: string;
  receiptNo: string;
  channel: 'MPESA' | 'BANK' | 'CASH' | 'CHEQUE';
  reference: string;
  chequeNo?: string;
  drawerBank?: string;
  splitFrom?: string | null;
  amount: string;
  paidAt: string;
  customerId: string | null;
  accountNo?: string;
  accountRef?: string;
  payerName?: string;
  payerPhone?: string;
  status: string;
  reversalReason?: string;
  accounting: SyncState;
}

export interface Cycle {
  id: string;
  period: string;
  status: string;
}
