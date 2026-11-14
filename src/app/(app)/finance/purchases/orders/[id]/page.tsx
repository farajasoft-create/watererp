'use client';

import { useParams } from 'next/navigation';
import { OrderView } from '@/modules/finance/ui/components/commercial/procurement';

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <OrderView id={id} />;
}
