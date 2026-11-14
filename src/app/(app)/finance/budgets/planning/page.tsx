'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { BudgetPlanningPage } from '@/modules/finance/ui/components/budget-planning';

function Inner() {
  const params = useSearchParams();
  return <BudgetPlanningPage initialTab={params.get('tab') ?? undefined} openSubmission={params.get('submission') ?? undefined} openChange={params.get('change') ?? undefined} />;
}

export default function Page() {
  return (
    <Suspense>
      <Inner />
    </Suspense>
  );
}
