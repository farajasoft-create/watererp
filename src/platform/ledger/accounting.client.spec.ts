import { describe, expect, it, vi } from 'vitest';
import { AccountingClient } from './accounting.client';
import { isBalanced, LedgerConfig } from './types';

describe('AccountingClient', () => {
  const config: LedgerConfig = { baseUrl: 'https://books.example.com', apiKey: 'fsk_test', entityId: 'e'.repeat(24), branchId: 'b'.repeat(24), mode: 'SUBMIT' };
  const lines = [
    { accountId: 'a'.repeat(24), description: 'x', debit: '10.00' },
    { accountId: 'b'.repeat(24), description: 'x', credit: '10.00' },
  ];

  it('creates the journal with an idempotency key and submits it', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(url.endsWith('/journals') ? { id: 'j1', status: 'DRAFT' } : { id: 'j1', status: 'SUBMITTED' }), { status: 201 });
    });
    const client = new AccountingClient(config, fetchImpl as unknown as typeof fetch);
    const id = await client.sendJournal(config, { date: '2026-10-31', description: 'Bills', reference: 'WATER-BILLS-2026-10', lines }, 'farajasoft:water:payment:1');
    expect(id).toBe('j1');
    expect(calls.map((c) => c.url)).toEqual(['https://books.example.com/api/v1/journals', 'https://books.example.com/api/v1/journals/j1/submit']);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer fsk_test');
    expect(headers['Idempotency-Key']).toBe('farajasoft:water:payment:1');
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ entityId: config.entityId, branchId: config.branchId, journalDate: '2026-10-31' });
  });

  it('reports what the ledger rejected', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: 'Validation failed', errors: [{ path: 'lines.0.accountId', message: 'Unknown account' }] }), { status: 400 }));
    const client = new AccountingClient(config, fetchImpl as unknown as typeof fetch);
    await expect(client.sendJournal(config, { date: '2026-10-31', description: 'x', reference: 'x', lines }, 'k')).rejects.toThrow(/Unknown account/);
  });
});

describe('isBalanced', () => {
  it('needs equal, non-zero debits and credits', () => {
    expect(isBalanced([{ accountId: 'a', description: '', debit: '5' }, { accountId: 'b', description: '', credit: '5.00' }])).toBe(true);
    expect(isBalanced([{ accountId: 'a', description: '', debit: '5' }, { accountId: 'b', description: '', credit: '4' }])).toBe(false);
    expect(isBalanced([])).toBe(false);
  });
});
