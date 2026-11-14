import { MovementsPage } from '@/modules/finance/ui/components/operations';

export default async function Page({ searchParams }: { searchParams: Promise<{ itemId?: string }> }) {
  const { itemId } = await searchParams;
  return <MovementsPage key={itemId ?? ""} itemId={itemId} />;
}
