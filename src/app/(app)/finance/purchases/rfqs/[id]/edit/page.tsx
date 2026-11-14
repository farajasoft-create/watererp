'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { RfqForm } from '@/modules/finance/ui/components/commercial/sourcing';
import { Loading, PageHeader } from '@/modules/finance/ui/components/ui';
import { api } from '@/modules/finance/ui/lib/api';

export default function Page() {
  const { id } = useParams<{ id: string }>();
  const { data } = useQuery({ queryKey: ['rfq', id], queryFn: () => api.get<Parameters<typeof RfqForm>[0]['existing']>(`/rfqs/${id}`) });
  if (!data) return <Loading />;
  return (
    <>
      <PageHeader title={`Edit ${data.number}`} />
      <RfqForm existing={data} />
    </>
  );
}
