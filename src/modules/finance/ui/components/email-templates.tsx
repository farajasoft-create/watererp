'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/modules/finance/ui/lib/api';
import { Badge, Button, Card, ErrorBanner, Field, Input, Loading, PageHeader, Textarea } from './ui';

interface Template { key: string; name: string; placeholders: string[]; customised: boolean; subject: string; intro: string; body: string; footer: string }
interface Preview { subject: string; intro: string; paragraphs: string[]; footer: string }

function Editor({ t }: { t: Template }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ subject: t.subject, intro: t.intro, body: t.body, footer: t.footer });
  const [preview, setPreview] = useState<Preview | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['email-templates'] });
  const save = useMutation({ mutationFn: () => api.patch(`/email-templates/${t.key}`, f), onSuccess: refresh });
  const reset = useMutation({ mutationFn: () => api.delete(`/email-templates/${t.key}`), onSuccess: refresh });
  const show = useMutation({ mutationFn: () => api.post<Preview>(`/email-templates/${t.key}/preview`, f), onSuccess: setPreview });
  const k = (key: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [key]: e.target.value });
  return (
    <Card title={<span>{t.name} {t.customised && <Badge tone="blue">customised</Badge>}</span>} actions={<><Button onClick={() => show.mutate()}>Preview</Button>{t.customised && <Button onClick={() => reset.mutate()} loading={reset.isPending}>Restore standard</Button>}<Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>Save</Button></>}>
      <ErrorBanner error={save.error || show.error || reset.error} />
      <p className="mb-2 text-xs text-gray-500">Placeholders: {t.placeholders.map((p) => <code key={p} className="mr-1">{`{{${p}}}`}</code>)}. Leave a blank line between paragraphs. Item tables and attachments are added automatically.</p>
      <div className="grid gap-2">
        <Field label="Subject"><Input value={f.subject} onChange={k('subject')} /></Field>
        <Field label="Greeting"><Input value={f.intro} onChange={k('intro')} /></Field>
        <Field label="Message"><Textarea rows={5} value={f.body} onChange={k('body')} /></Field>
        <Field label="Footer"><Input value={f.footer} onChange={k('footer')} /></Field>
      </div>
      {preview && (
        <div className="mt-3 rounded border bg-gray-50 p-3 text-sm">
          <div className="font-semibold">{preview.subject}</div>
          <p className="mt-2">{preview.intro}</p>
          {preview.paragraphs.map((p, i) => <p key={i} className="mt-2">{p}</p>)}
          <p className="mt-2 text-xs text-gray-500">{preview.footer}</p>
        </div>
      )}
    </Card>
  );
}

/** The wording of the emails sent to suppliers: requests for quotation, purchase orders and remittance advice. */
export function EmailTemplatesPage() {
  const list = useQuery({ queryKey: ['email-templates'], queryFn: () => api.get<Template[]>('/email-templates') });
  return (
    <div className="space-y-4">
      <PageHeader title="Email templates" description="The wording of the emails sent to suppliers. Changes apply to the next email sent." />
      <ErrorBanner error={list.error} />
      {!list.data ? <Loading /> : list.data.map((t) => <Editor key={`${t.key}${t.customised}${t.subject}`} t={t} />)}
    </div>
  );
}
