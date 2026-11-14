export const WORK_TYPES = ['LEAK_REPAIR', 'BURST_REPAIR', 'NEW_CONNECTION', 'METER_INSTALLATION', 'METER_REPLACEMENT', 'DISCONNECTION', 'RECONNECTION', 'PREVENTIVE', 'CORRECTIVE', 'INSPECTION', 'SEWER_UNBLOCKING', 'OTHER'];
export const WORK_PRIORITIES = ['LOW', 'NORMAL', 'URGENT', 'EMERGENCY'];

export interface WorkOrder {
  id: string;
  number: string;
  type: string;
  priority: string;
  status: string;
  title: string;
  description?: string;
  ticketId?: string | null;
  customerId?: string | null;
  facilityId?: string | null;
  assetRef?: string;
  location?: string;
  gps?: { lat?: number; lng?: number };
  assignedTo: string[];
  assignedNames?: string[];
  dueAt?: string;
  startedAt?: string;
  completedAt?: string;
  findings?: string;
  labourHours?: string;
  materials?: { itemCode?: string; description: string; quantity: string; unitCost: string }[];
  materialsCost?: string;
  checklist?: { item: string; done: boolean }[];
  overdue?: boolean;
  createdAt: string;
  history?: { at: string; by?: string; action: string; note?: string }[];
  names?: Record<string, string>;
  customer?: { accountNo: string; name: string; phone?: string } | null;
  facility?: { code: string; name: string } | null;
  ticket?: { number: string; subject: string } | null;
}
