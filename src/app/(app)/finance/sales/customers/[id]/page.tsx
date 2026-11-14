'use client';

import { useParams } from 'next/navigation';
import { PartyDetail } from '@/modules/finance/ui/components/commercial/parties';
import { SALES } from '@/modules/finance/ui/lib/commercial';

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <PartyDetail side={SALES} id={id} />;
}
