'use client';

import { JournalForm } from '@/modules/finance/ui/components/journal-form';
import { PageHeader } from '@/modules/finance/ui/components/ui';
import { useSession } from '@/modules/finance/ui/lib/session';

export default function NewJournalPage() {
  const { entity } = useSession();
  return (
    <>
      <PageHeader title="New journal" description={`${entity!.code} · ${entity!.name} · functional currency ${entity!.functionalCurrency}`} />
      <JournalForm />
    </>
  );
}
