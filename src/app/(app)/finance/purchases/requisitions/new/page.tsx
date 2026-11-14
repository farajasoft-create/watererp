'use client';

import { RequisitionForm } from '@/modules/finance/ui/components/commercial/procurement';
import { PageHeader } from '@/modules/finance/ui/components/ui';

export default function Page() {
  return (
    <>
      <PageHeader title="New requisition" />
      <RequisitionForm />
    </>
  );
}
