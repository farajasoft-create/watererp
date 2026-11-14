'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { JournalForm } from '@/modules/finance/ui/components/journal-form';
import { ErrorBanner, Loading, Notice, PageHeader } from '@/modules/finance/ui/components/ui';
import { api } from '@/modules/finance/ui/lib/api';
import { useSession } from '@/modules/finance/ui/lib/session';
import type { Journal } from '@/modules/finance/ui/lib/types';

export default function EditJournalPage() {
  const { id } = useParams<{ id: string }>();
  const { entity } = useSession();
  const { data, isLoading, error } = useQuery({ queryKey: ['journal', id], queryFn: () => api.get<Journal>(`/journals/${id}`) });
  if (isLoading) return <Loading />;
  if (!data) return <ErrorBanner error={error ?? 'Journal not found'} />;
  if (data.status !== 'DRAFT' && data.status !== 'REJECTED') return <Notice tone="amber">Only draft or rejected journals can be edited.</Notice>;
  if (data.entityId !== entity!.id) return <Notice tone="amber">Switch to this journal&apos;s entity to edit it.</Notice>;
  return (
    <>
      <PageHeader title={`Edit ${data.number}`} description="Saving returns the journal to draft." />
      <JournalForm journal={data} />
    </>
  );
}
