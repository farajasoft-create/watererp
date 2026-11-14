'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, ErrorBox, Field, Input, Modal, Textarea } from '@/components/ui';
import { api } from './api';
import { WorkOrder } from './works';

/** The field team's report: findings, labour, materials used and the checklist; GPS from the phone when allowed. */
export function JobComplete({ job, onClose }: { job: WorkOrder; onClose: () => void }) {
  const qc = useQueryClient();
  const [findings, setFindings] = useState('');
  const [hours, setHours] = useState('');
  const [materials, setMaterials] = useState<{ itemCode: string; description: string; quantity: string; unitCost: string }[]>([]);
  const [checklist, setChecklist] = useState(job.checklist ?? []);
  const save = useMutation({
    mutationFn: async () => {
      const gps = await new Promise<{ lat: number; lng: number } | null>((resolve) => {
        if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }), () => resolve(null), { timeout: 5000 });
      });
      return api.post(`/work-orders/${job.id}/complete`, {
        findings,
        labourHours: hours || undefined,
        materials: materials.filter((m) => m.description && m.quantity).map((m) => ({ ...m, itemCode: m.itemCode || undefined, unitCost: m.unitCost || undefined })),
        checklist: checklist.length ? checklist : undefined,
        gps,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['work-orders'] });
      qc.invalidateQueries({ queryKey: ['work-order', job.id] });
      onClose();
    },
  });
  return (
    <Modal open wide onClose={onClose} title={`Report ${job.number} done`} footer={<Button onClick={() => save.mutate()} disabled={save.isPending || findings.length < 3}>Job done</Button>}>
      <ErrorBox error={save.error} />
      <Field label="What was found and done"><Textarea rows={3} value={findings} onChange={(e) => setFindings(e.target.value)} /></Field>
      <Field label="Labour (hours)"><Input inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} className="max-w-[10rem]" /></Field>
      {checklist.length > 0 && (
        <div className="space-y-1 text-sm">
          {checklist.map((c, i) => (
            <label key={i} className="flex items-center gap-2"><input type="checkbox" checked={c.done} onChange={(e) => setChecklist(checklist.map((x, j) => (j === i ? { ...x, done: e.target.checked } : x)))} /> {c.item}</label>
          ))}
        </div>
      )}
      <div className="space-y-2">
        <div className="text-xs font-medium text-muted">Spare parts and materials used</div>
        {materials.map((m, i) => (
          <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Input placeholder="Item code" value={m.itemCode} onChange={(e) => setMaterials(materials.map((x, j) => (j === i ? { ...x, itemCode: e.target.value } : x)))} />
            <Input placeholder="Description" value={m.description} onChange={(e) => setMaterials(materials.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
            <Input placeholder="Quantity" inputMode="decimal" value={m.quantity} onChange={(e) => setMaterials(materials.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
            <Input placeholder="Unit cost" inputMode="decimal" value={m.unitCost} onChange={(e) => setMaterials(materials.map((x, j) => (j === i ? { ...x, unitCost: e.target.value } : x)))} />
          </div>
        ))}
        <Button variant="secondary" onClick={() => setMaterials([...materials, { itemCode: '', description: '', quantity: '', unitCost: '' }])}>Add material</Button>
      </div>
    </Modal>
  );
}
