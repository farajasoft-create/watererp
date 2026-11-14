'use client';

import { Suspense } from 'react';
import { DocumentList } from '@/modules/finance/ui/components/commercial/documents';
import { Loading } from '@/modules/finance/ui/components/ui';
import { SALES } from '@/modules/finance/ui/lib/commercial';

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <DocumentList side={SALES} />
    </Suspense>
  );
}
