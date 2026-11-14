'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Checkbox, ErrorBanner, Field, Input, Notice, PageHeader, Select } from '@/modules/finance/ui/components/ui';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { useAccounts, useCurrencies, useSession } from '@/modules/finance/ui/lib/session';
import type { Account } from '@/modules/finance/ui/lib/types';
import { EmailSettingsCard, PackSubscriptionCard, ScimSettingsCard, SsoSettingsCard } from '@/modules/finance/ui/components/communication';
import { SmsSettingsCard } from '@/modules/finance/ui/components/compliance';

export default function OrganisationPage() {
  const { me, can } = useSession();
  const queryClient = useQueryClient();
  const org = me.organisation;
  const { data: accounts = [] } = useAccounts();
  const { data: currencies = [] } = useCurrencies();
  const [form, setForm] = useState({
    name: org.name,
    reportingCurrency: org.reportingCurrency,
    retainedEarningsAccountId: org.settings.retainedEarningsAccountId ?? '',
    requireJournalApproval: org.settings.requireJournalApproval,
    supplierOnboardingApproval: org.settings.supplierOnboardingApproval ?? false,
    requireProcurementPlan: org.settings.requireProcurementPlan ?? false,
    requireGoodsInspection: org.settings.requireGoodsInspection ?? false,
    stockInTransitAccountId: org.settings.stockInTransitAccountId ?? '',
    receivablesAccountId: org.settings.receivablesAccountId ?? '',
    payablesAccountId: org.settings.payablesAccountId ?? '',
    fxGainAccountId: org.settings.fxGainAccountId ?? '',
    fxLossAccountId: org.settings.fxLossAccountId ?? '',
    matchTolerancePercent: org.settings.matchTolerancePercent ?? '',
    unrealisedFxGainAccountId: org.settings.unrealisedFxGainAccountId ?? '',
    unrealisedFxLossAccountId: org.settings.unrealisedFxLossAccountId ?? '',
    interBranchAccountId: org.settings.interBranchAccountId ?? '',
    employeeClaimsAccountId: org.settings.employeeClaimsAccountId ?? '',
    budgetControl: org.settings.budgetControl ?? 'WARN',
    budgetAlertPercent: org.settings.budgetAlertPercent == null ? '' : String(org.settings.budgetAlertPercent),
    requireMfa: org.settings.requireMfa ?? false,
    aiEnabled: org.settings.aiEnabled ?? false,
    documentRetentionYears: String(org.settings.documentRetentionYears ?? 7),
  });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = can('org.manage');

  const save = useMutation({
    mutationFn: () =>
      api.patch('/organisation', {
        name: form.name,
        reportingCurrency: form.reportingCurrency,
        settings: {
          retainedEarningsAccountId: form.retainedEarningsAccountId || null,
          requireJournalApproval: form.requireJournalApproval,
          supplierOnboardingApproval: form.supplierOnboardingApproval,
          requireProcurementPlan: form.requireProcurementPlan,
          requireGoodsInspection: form.requireGoodsInspection,
          stockInTransitAccountId: form.stockInTransitAccountId || null,
          receivablesAccountId: form.receivablesAccountId || null,
          payablesAccountId: form.payablesAccountId || null,
          fxGainAccountId: form.fxGainAccountId || null,
          fxLossAccountId: form.fxLossAccountId || null,
          matchTolerancePercent: form.matchTolerancePercent || null,
          unrealisedFxGainAccountId: form.unrealisedFxGainAccountId || null,
          unrealisedFxLossAccountId: form.unrealisedFxLossAccountId || null,
          interBranchAccountId: form.interBranchAccountId || null,
          employeeClaimsAccountId: form.employeeClaimsAccountId || null,
          budgetControl: form.budgetControl,
          budgetAlertPercent: form.budgetAlertPercent ? Number(form.budgetAlertPercent) : null,
          requireMfa: form.requireMfa,
          aiEnabled: form.aiEnabled,
          documentRetentionYears: Number(form.documentRetentionYears) || 7,
        },
      }),
    onSuccess: () => {
      setSaved(true);
      setError(null);
      queryClient.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err) => setError(errorMessage(err)),
  });

  return (
    <>
      <PageHeader title="Organisation" description="Group-wide settings that apply to every entity." />
      <div className="max-w-2xl space-y-4">
        <ErrorBanner error={error} />
        {saved && <Notice tone="green">Settings saved.</Notice>}
        <Card title="Profile">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Organisation name" className="sm:col-span-2">
              <Input disabled={!editable} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Group reporting currency" hint="Used for consolidated reporting (phase 3)">
              <Select disabled={!editable} value={form.reportingCurrency} onChange={(e) => setForm({ ...form, reportingCurrency: e.target.value })}>
                {currencies.map((c) => (
                  <option key={c.code} value={c.code}>{c.code} · {c.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Tenant ID">
              <Input disabled value={org.slug} />
            </Field>
          </div>
        </Card>
        <Card title="Accounting controls">
          <div className="space-y-4">
            <Field label="Retained earnings account" hint="Prior-year profit and loss rolls into this account on the trial balance and balance sheet.">
              <Select
                disabled={!editable}
                value={form.retainedEarningsAccountId}
                onChange={(e) => setForm({ ...form, retainedEarningsAccountId: e.target.value })}
              >
                <option value="">Not set</option>
                {accounts.filter((a) => a.accountClass === 'EQUITY' && a.isPostable).map((a) => (
                  <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                ))}
              </Select>
            </Field>
            <Checkbox
              disabled={!editable}
              label="Require a second person to approve journals, invoices, bills and supplier payments (maker-checker)"
              checked={form.requireJournalApproval}
              onChange={(v) => setForm({ ...form, requireJournalApproval: v })}
            />
            {!form.requireJournalApproval && (
              <Notice tone="amber">
                Without approval, users with the post permission can post their own journals directly. Recommended only for very small teams.
              </Notice>
            )}
            <Checkbox
              disabled={!editable}
              label="New suppliers need procurement approval before they can be ordered from, billed or paid (vendor onboarding)"
              checked={form.supplierOnboardingApproval}
              onChange={(v) => setForm({ ...form, supplierOnboardingApproval: v })}
            />
            <Checkbox
              disabled={!editable}
              label="Every requisition line must draw on an item of the approved annual procurement plan"
              checked={form.requireProcurementPlan}
              onChange={(v) => setForm({ ...form, requireProcurementPlan: v })}
            />
            <Checkbox
              disabled={!editable}
              label="Deliveries must be accepted by an inspection committee before they can be billed"
              checked={form.requireGoodsInspection}
              onChange={(v) => setForm({ ...form, requireGoodsInspection: v })}
            />
            <Field label="Stock in transit account" hint="Holds stock dispatched to another store until it is received; blank keeps it in the inventory account">
              <Select disabled={!editable} value={form.stockInTransitAccountId} onChange={(e) => setForm({ ...form, stockInTransitAccountId: e.target.value })}>
                <option value="">None</option>
                {accounts.filter((a) => a.isPostable && a.accountClass === 'ASSET').map((a) => (
                  <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>
        <Card title="Receivables, payables & FX">
          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                ['receivablesAccountId', 'Receivables control account', (a: Account) => a.accountType === 'RECEIVABLE'],
                ['payablesAccountId', 'Payables control account', (a: Account) => a.accountType === 'PAYABLE'],
                ['fxGainAccountId', 'Realised FX gain', (a: Account) => a.accountClass === 'REVENUE'],
                ['fxLossAccountId', 'Realised FX loss', (a: Account) => a.accountClass === 'EXPENSE'],
                ['unrealisedFxGainAccountId', 'Unrealised FX gain (revaluation)', (a: Account) => a.accountClass === 'REVENUE'],
                ['unrealisedFxLossAccountId', 'Unrealised FX loss (revaluation)', (a: Account) => a.accountClass === 'EXPENSE'],
                ['interBranchAccountId', 'Inter-branch clearing account', (a: Account) => a.accountType === 'INTER_BRANCH' && !a.allowManualPosting],
                ['employeeClaimsAccountId', 'Employee claims payable', (a: Account) => a.accountClass === 'LIABILITY' && !a.allowManualPosting],
              ] as const
            ).map(([key, label, filter]) => (
              <Field key={key} label={label}>
                <Select disabled={!editable} value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })}>
                  <option value="">Not set</option>
                  {accounts.filter((a) => a.isPostable && filter(a)).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} · {a.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ))}
            <Field label="Bill price tolerance (%)" hint="How far a bill's unit price may exceed the purchase order before matching fails">
              <Input
                disabled={!editable}
                inputMode="decimal"
                value={form.matchTolerancePercent}
                onChange={(e) => /^\d*(\.\d*)?$/.test(e.target.value) && setForm({ ...form, matchTolerancePercent: e.target.value })}
              />
            </Field>
          </div>
          <p className="mt-3 text-xs text-muted">Control accounts only accept postings from the subledgers, so they always agree with the open invoices and bills.</p>
        </Card>
        <Card title="Security & records">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Checkbox
                disabled={!editable || (!me.mfaEnabled && !form.requireMfa)}
                label="Require two-step verification for every user"
                checked={form.requireMfa}
                onChange={(v) => setForm({ ...form, requireMfa: v })}
              />
              <p className="mt-1 text-xs text-muted">
                {me.mfaEnabled ? 'Users without it are asked to set it up before they can continue. API keys are not affected.' : 'Turn on two-step verification for your own account first (Account security).'}
              </p>
            </div>
            <Field label="Keep documents on posted records for (years)" hint="Attachments on posted or approved records cannot be deleted during this period">
              <Input disabled={!editable} inputMode="numeric" value={form.documentRetentionYears} onChange={(e) => /^\d{0,2}$/.test(e.target.value) && setForm({ ...form, documentRetentionYears: e.target.value })} />
            </Field>
          </div>
        </Card>
        {editable && <SsoSettingsCard />}
        {editable && <ScimSettingsCard />}
        {can('users.manage') && <EmailSettingsCard />}
        <SmsSettingsCard />
        {editable && <PackSubscriptionCard />}
        <Card title="AI assistance">
          <Checkbox
            disabled={!editable}
            label="Allow AI assistance (invoice capture and questions about the figures)"
            checked={form.aiEnabled}
            onChange={(v) => setForm({ ...form, aiEnabled: v })}
          />
          <p className="mt-1 text-xs text-muted">
            When on, invoice files and the report figures needed to answer a question are sent to Anthropic&apos;s Claude for processing. Users also need the AI permission in their role. Suggestions are never posted without review, and every request is logged.
          </p>
          {editable && <AiUsage />}
        </Card>
        <Card title="Budget control">
          <Field label="When a purchase order or bill would exceed the approved budget" hint="Users with the budget override permission can still approve blocked spending">
            <Select disabled={!editable} value={form.budgetControl} onChange={(e) => setForm({ ...form, budgetControl: e.target.value as 'OFF' | 'WARN' | 'BLOCK' })}>
              <option value="OFF">Do nothing</option>
              <option value="WARN">Warn and record it in the audit trail</option>
              <option value="BLOCK">Block approval</option>
            </Select>
          </Field>
          <Field label="Notify department heads when a budget line is this % used" hint="Spending plus open purchase orders; checked daily. Leave blank to turn notices off." className="mt-3">
            <Input disabled={!editable} className="w-24" inputMode="numeric" value={form.budgetAlertPercent} onChange={(e) => /^\d{0,3}$/.test(e.target.value) && Number(e.target.value || 0) <= 100 && setForm({ ...form, budgetAlertPercent: e.target.value })} />
          </Field>
        </Card>
        {editable && (
          <div className="flex justify-end">
            <Button variant="primary" loading={save.isPending} onClick={() => (setSaved(false), save.mutate())}>
              Save settings
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

function AiUsage() {
  const status = useQuery({ queryKey: ['ai-status'], queryFn: () => api.get<{ configured: boolean; model: string | null }>('/ai/status') });
  const usage = useQuery({ queryKey: ['ai-usage'], queryFn: () => api.get<{ feature: string; requests: number; inputTokens: number; outputTokens: number; failures: number }[]>('/ai/usage') });
  if (!status.data) return null;
  if (!status.data.configured) return <p className="mt-2 text-xs text-amber-700">This server has no ANTHROPIC_API_KEY, so AI assistance is unavailable.</p>;
  return (
    <p className="mt-2 text-xs text-muted">
      Model {status.data.model}. Last 30 days:{' '}
      {usage.data?.length ? usage.data.map((u) => `${u.feature.replace('_', ' ')} ${u.requests} request${u.requests === 1 ? '' : 's'} (${(u.inputTokens + u.outputTokens).toLocaleString('en')} tokens)`).join(', ') : 'no requests'}.
    </p>
  );
}
