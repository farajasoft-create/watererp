'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { OrderForm } from '@/modules/finance/ui/components/commercial/procurement';
import { Loading, PageHeader } from '@/modules/finance/ui/components/ui';
import { api } from '@/modules/finance/ui/lib/api';
import { PurchaseOrder } from '@/modules/finance/ui/lib/commercial';

export default function Page() {
  const { id } = useParams<{ id: string }>();
  const { data } = useQuery({ queryKey: ['purchase-order', id], queryFn: () => api.get<PurchaseOrder>(`/purchase-orders/${id}`) });
  if (!data) return <Loading />;
  return (
    <Suspense fallback={<Loading />}>
      <PageHeader title={`Edit ${data.number}`} />
      <OrderForm existing={data} />
    </Suspense>
  );
}
