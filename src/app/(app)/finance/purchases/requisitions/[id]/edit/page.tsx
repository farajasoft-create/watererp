'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { RequisitionForm } from '@/modules/finance/ui/components/commercial/procurement';
import { Loading, PageHeader } from '@/modules/finance/ui/components/ui';
import { api } from '@/modules/finance/ui/lib/api';
import { Requisition } from '@/modules/finance/ui/lib/commercial';

export default function Page() {
  const { id } = useParams<{ id: string }>();
  const { data } = useQuery({ queryKey: ['requisition', id], queryFn: () => api.get<Requisition>(`/requisitions/${id}`) });
  if (!data) return <Loading />;
  return (
    <>
      <PageHeader title={`Edit ${data.number}`} />
      <RequisitionForm existing={data} />
    </>
  );
}
