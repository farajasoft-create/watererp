'use client';

import { useParams } from 'next/navigation';
import { RequisitionView } from '@/modules/finance/ui/components/commercial/procurement';

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <RequisitionView id={id} />;
}
