'use client';

import { Suspense } from 'react';
import { OrderForm } from '@/modules/finance/ui/components/commercial/procurement';
import { Loading, PageHeader } from '@/modules/finance/ui/components/ui';

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <PageHeader title="New purchase order" />
      <OrderForm />
    </Suspense>
  );
}
