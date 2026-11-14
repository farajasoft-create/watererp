'use client';

import { useParams } from 'next/navigation';
import { PaymentView } from '@/modules/finance/ui/components/commercial/payments';

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <PaymentView id={id} />;
}
