'use client';

import { Suspense } from 'react';
import { SponsorshipsPage } from '@/modules/finance/ui/components/sponsorships';
import { Loading } from '@/modules/finance/ui/components/ui';

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <SponsorshipsPage />
    </Suspense>
  );
}
