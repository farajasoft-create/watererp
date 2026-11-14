'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { TreasuryPage } from '@/modules/finance/ui/components/treasury';

function Inner() {
  return <TreasuryPage openId={useSearchParams().get('open') ?? undefined} />;
}

export default function Page() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
