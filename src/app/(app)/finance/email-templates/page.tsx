'use client';

import { Suspense } from 'react';
import { EmailTemplatesPage } from '@/modules/finance/ui/components/email-templates';
import { Loading } from '@/modules/finance/ui/components/ui';

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <EmailTemplatesPage />
    </Suspense>
  );
}
