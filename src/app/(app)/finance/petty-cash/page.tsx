'use client';

import { Suspense } from 'react';
import { PettyCashPage } from '@/modules/finance/ui/components/petty-cash';
import { Loading } from '@/modules/finance/ui/components/ui';

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <PettyCashPage />
    </Suspense>
  );
}
