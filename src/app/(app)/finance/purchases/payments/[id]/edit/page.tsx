'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { PaymentForm } from '@/modules/finance/ui/components/commercial/payments';
import { ErrorBanner, Loading, PageHeader } from '@/modules/finance/ui/components/ui';
import { api } from '@/modules/finance/ui/lib/api';
import { PaymentDetail } from '@/modules/finance/ui/lib/commercial';

export default function Page() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useQuery({ queryKey: ['payment', id], queryFn: () => api.get<PaymentDetail>(`/payments/${id}`) });
  if (isLoading) return <Loading />;
  if (!data) return <ErrorBanner error={error ?? 'Not found'} />;
  return (
    <Suspense fallback={<Loading />}>
      <PageHeader title={`Edit ${data.number}`} />
      <PaymentForm kind={data.kind} existing={data} />
    </Suspense>
  );
}
