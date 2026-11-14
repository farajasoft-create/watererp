'use client';

import { useParams } from 'next/navigation';
import { AssetDetail } from '@/modules/finance/ui/components/operations';

export default function Page() {
  const { id } = useParams<{ id: string }>();
  return <AssetDetail id={id} />;
}
