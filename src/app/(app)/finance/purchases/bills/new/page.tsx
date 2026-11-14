'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { DocumentForm } from '@/modules/finance/ui/components/commercial/documents';
import { Loading, PageHeader } from '@/modules/finance/ui/components/ui';
import { DocumentKind, KIND_LABEL, PURCHASES } from '@/modules/finance/ui/lib/commercial';

function NewDocument() {
  const kind = (useSearchParams().get('kind') === PURCHASES.creditKind ? PURCHASES.creditKind : PURCHASES.documentKind) as DocumentKind;
  return (
    <>
      <PageHeader title={`New ${KIND_LABEL[kind].toLowerCase()}`} />
      <DocumentForm key={kind} kind={kind} />
    </>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <NewDocument />
    </Suspense>
  );
}
