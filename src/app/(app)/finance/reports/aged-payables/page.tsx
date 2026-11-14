'use client';

import { AgingReport } from '@/modules/finance/ui/components/commercial/reports';
import { PURCHASES } from '@/modules/finance/ui/lib/commercial';

export default function Page() {
  return <AgingReport side={PURCHASES} />;
}
