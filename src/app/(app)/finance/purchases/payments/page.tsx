'use client';

import { PaymentList } from '@/modules/finance/ui/components/commercial/payments';
import { PURCHASES } from '@/modules/finance/ui/lib/commercial';

export default function Page() {
  return <PaymentList side={PURCHASES} />;
}
