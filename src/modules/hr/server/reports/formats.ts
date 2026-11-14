import { z } from 'zod';
import { exportResult } from '@/modules/bi/server/exports';
import type { QueryResult, ResultColumn } from '@/modules/bi/server/engine';
import { parseCsv } from '@/platform/common/csv';

export { parseCsv };

/** Every HR table downloads as CSV (text), Excel, Word or PDF. */
export const FILE_FORMATS = ['csv', 'xls', 'doc', 'pdf'] as const;
export type FileFormat = (typeof FILE_FORMATS)[number];
export const zFileFormat = z.enum(FILE_FORMATS);

/** A table (first row the headings) as a result the BI exporters print; all-numeric columns are right-aligned. */
export function tableResult(title: string, table: string[][]): QueryResult {
  const [head = [], ...body] = table;
  const columns: ResultColumn[] = head.map((label, i) => ({ key: `c${i}`, label, type: body.length && body.every((r) => r[i] === undefined || r[i] === '' || /^-?\d+(\.\d+)?$/.test(r[i])) ? 'number' : 'text' }));
  return { dataset: { key: 'hr', label: title }, columns, rows: body.map((r) => Object.fromEntries(head.map((_, i) => [`c${i}`, r[i] ?? '']))), truncated: false, ranAt: new Date() };
}

/** Converts a CSV download into the asked format (CSV passes through untouched). */
export async function inFormat(csv: Response | Promise<Response>, format: FileFormat, title: string, organisation: string): Promise<Response> {
  const res = await csv;
  if (format === 'csv') return res;
  return exportResult(tableResult(title, parseCsv(await res.text())), title, organisation, format);
}
