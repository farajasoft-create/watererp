'use client';

import { Suspense } from 'react';
import { PaymentForm } from '@/modules/finance/ui/components/commercial/payments';
import { Loading, PageHeader } from '@/modules/finance/ui/components/ui';
import { PURCHASES } from '@/modules/finance/ui/lib/commercial';

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <PageHeader title={`New ${PURCHASES.payment.toLowerCase()}`} />
      <PaymentForm kind={PURCHASES.paymentKind} />
    </Suspense>
  );
}
