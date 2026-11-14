'use client';

import { RfqForm } from '@/modules/finance/ui/components/commercial/sourcing';
import { PageHeader } from '@/modules/finance/ui/components/ui';

export default function Page() {
  return (
    <>
      <PageHeader title="New request for quotes" />
      <RfqForm />
    </>
  );
}
