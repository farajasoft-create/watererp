'use client';

import { Suspense } from 'react';
import { ImprestPage } from '@/modules/finance/ui/components/imprest';
import { Loading } from '@/modules/finance/ui/components/ui';

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <ImprestPage />
    </Suspense>
  );
}
