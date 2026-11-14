'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button, Card, ErrorBox, Field, Input, Notice, Textarea } from '@/components/ui';

interface Account { businessName: string; reference: string; description?: string; products: { name: string; description?: string; price?: string | null; unit?: string }[] }
type Row = { name: string; description: string; price: string; unit: string };

/** A listed business keeps its own products up to date through the link it was texted. */
export default function MsmeAccountPage() {
  const { token } = useParams<{ token: string }>();
  const [a, setA] = useState<Account | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(`/api/v1/portals/msme-account/${encodeURIComponent(token)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error(body?.message ?? 'This link is not valid');
        if (!live) return;
        setA(body);
        setDescription(body.description ?? '');
        setRows(body.products.map((p: Account['products'][number]) => ({ name: p.name, description: p.description ?? '', price: p.price ?? '', unit: p.unit ?? '' })));
      })
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, [token]);
  const save = async () => {
    setError(null);
    setSaved(false);
    const res = await fetch(`/api/v1/portals/msme-account/${encodeURIComponent(token)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description, products: rows.filter((r) => r.name).map((r) => ({ name: r.name, description: r.description || undefined, price: r.price || null, unit: r.unit || undefined })) }) });
    const body = await res.json().catch(() => null);
    if (!res.ok) setError(new Error(body?.errors?.[0]?.message ?? body?.message ?? 'Could not save'));
    else setSaved(true);
  };
  return (
    <main className="mx-auto max-w-3xl space-y-4 px-4 py-8">
      <ErrorBox error={error} />
      {a && (
        <Card title={`${a.businessName} (${a.reference})`}>
          <div className="space-y-3">
            {saved && <Notice tone="green">Saved; the portal shows the new list now.</Notice>}
            <Field label="What you do"><Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
            {rows.map((r, i) => (
              <div key={i} className="grid gap-2 sm:grid-cols-[2fr_2fr_1fr_1fr_auto]">
                <Input placeholder="Product" value={r.name} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <Input placeholder="Description" value={r.description} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
                <Input placeholder="Price" value={r.price} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
                <Input placeholder="Unit" value={r.unit} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))} />
                <Button variant="secondary" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="Remove">✕</Button>
              </div>
            ))}
            <div className="flex gap-2"><Button variant="secondary" onClick={() => setRows([...rows, { name: '', description: '', price: '', unit: '' }])}>Add a product</Button><Button onClick={save}>Save</Button></div>
          </div>
        </Card>
      )}
    </main>
  );
}
