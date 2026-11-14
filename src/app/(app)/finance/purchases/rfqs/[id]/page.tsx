'use client';

import { useParams } from 'next/navigation';
import { RfqView } from '@/modules/finance/ui/components/commercial/sourcing';

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <RfqView id={id} />;
}
