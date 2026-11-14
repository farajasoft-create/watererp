'use client';

import { useParams } from 'next/navigation';
import { DocumentView } from '@/modules/finance/ui/components/commercial/documents';

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <DocumentView id={id} />;
}
