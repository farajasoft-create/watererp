'use client';

import { PartyList } from '@/modules/finance/ui/components/commercial/parties';
import { PURCHASES } from '@/modules/finance/ui/lib/commercial';

export default function Page() {
  return <PartyList side={PURCHASES} />;
}
