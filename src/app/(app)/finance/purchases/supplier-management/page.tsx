'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { SupplierManagementPage } from '@/modules/finance/ui/components/commercial/supplier-management';

function Inner() {
  const tab = useSearchParams().get('tab') ?? undefined;
  return <SupplierManagementPage initialTab={tab} />;
}

export default function Page() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
