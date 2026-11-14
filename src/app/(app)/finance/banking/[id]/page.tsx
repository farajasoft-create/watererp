'use client';

import { useParams } from 'next/navigation';
import { BankAccountPage } from '@/modules/finance/ui/components/commercial/banking';

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <BankAccountPage id={id} />;
}
