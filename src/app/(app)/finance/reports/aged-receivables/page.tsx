'use client';

import { AgingReport } from '@/modules/finance/ui/components/commercial/reports';
import { SALES } from '@/modules/finance/ui/lib/commercial';

export default function Page() {
  return <AgingReport side={SALES} />;
}
