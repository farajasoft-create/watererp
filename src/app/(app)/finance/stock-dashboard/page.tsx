'use client';

import { Suspense } from 'react';
import { StockDashboardPage } from '@/modules/finance/ui/components/stock-dashboard';
import { Loading } from '@/modules/finance/ui/components/ui';

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <StockDashboardPage />
    </Suspense>
  );
}
