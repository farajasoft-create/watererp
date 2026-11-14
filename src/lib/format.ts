const money = new Intl.NumberFormat('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const units = new Intl.NumberFormat('en-KE', { maximumFractionDigits: 2 });

export function fmtMoney(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  return money.format(Number(value));
}

export function fmtUnits(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  return units.format(Number(value));
}

export function fmtDate(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-KE', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-KE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function currentPeriod(): string {
  return new Date().toISOString().slice(0, 7);
}

export function label(value: string | null | undefined): string {
  if (!value) return '—';
  return value
    .toLowerCase()
    .split('_')
    .join(' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}
