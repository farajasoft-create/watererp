'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { DocumentForm } from '@/modules/finance/ui/components/commercial/documents';
import { ErrorBanner, Loading, PageHeader } from '@/modules/finance/ui/components/ui';
import { api } from '@/modules/finance/ui/lib/api';
import { DocumentDetail, KIND_LABEL } from '@/modules/finance/ui/lib/commercial';

export default function Page() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useQuery({ queryKey: ['document', id], queryFn: () => api.get<DocumentDetail>(`/invoices/${id}`) });
  if (isLoading) return <Loading />;
  if (!data) return <ErrorBanner error={error ?? 'Not found'} />;
  return (
    <Suspense fallback={<Loading />}>
      <PageHeader title={`Edit ${KIND_LABEL[data.kind].toLowerCase()} ${data.number}`} />
      <DocumentForm kind={data.kind} existing={data} />
    </Suspense>
  );
}
