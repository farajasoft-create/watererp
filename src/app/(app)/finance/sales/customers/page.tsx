'use client';

import { PartyList } from '@/modules/finance/ui/components/commercial/parties';
import { SALES } from '@/modules/finance/ui/lib/commercial';

export default function Page() {
  return <PartyList side={SALES} />;
}
