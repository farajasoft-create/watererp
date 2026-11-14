import { renderDocumentPdf } from '@/modules/finance/core/common/document-pdf';
import { toCsv } from '@/platform/common/csv';
import { pptx } from '@/platform/common/pptx';
import type { QueryResult, ResultColumn } from './engine';

export const EXPORT_FORMATS = ['csv', 'xls', 'pdf', 'doc', 'pptx'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const safeName = (s: string) => s.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').slice(0, 80) || 'report';

/** A cell as text: dates as days (or months for monthly groups), money with two decimals. */
export function cellText(c: ResultColumn, v: unknown): string {
  if (v === null || v === undefined) return '';
  if (c.type === 'date') {
    const d = v instanceof Date ? v : new Date(String(v));
    return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
  }
  if (c.type === 'money' && typeof v === 'number') return v.toFixed(2);
  return String(v);
}

/** The table a result prints as: the cross-tab for a pivot, otherwise its rows. */
export function tableOf(r: QueryResult): { columns: ResultColumn[]; rows: string[][]; numeric: boolean[] } {
  if (r.pivot) {
    const p = r.pivot;
    const rc = r.columns.find((c) => c.key === p.rowKey)!;
    const cc = r.columns.find((c) => c.key === p.colKey)!;
    const mc = r.columns.find((c) => c.key === p.measure)!;
    const key = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? '(blank)' : String(v));
    const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '' : mc.type === 'money' ? n.toFixed(2) : String(n));
    const columns: ResultColumn[] = [rc, ...p.colValues.map((v) => ({ key: key(v), label: cellText(cc, v) || '(blank)', type: mc.type })), { key: '_total', label: 'Total', type: mc.type }];
    const rows = p.rowValues.map((rv) => [cellText(rc, rv) || '(blank)', ...p.colValues.map((cv) => fmt(p.cells[key(rv)]?.[key(cv)])), fmt(p.rowTotals[key(rv)])]);
    rows.push(['Total', ...p.colValues.map((cv) => fmt(p.colTotals[key(cv)])), fmt(p.total)]);
    return { columns, rows, numeric: columns.map((c, i) => i > 0 || c.type === 'number' || c.type === 'money') };
  }
  return { columns: r.columns, rows: r.rows.map((row) => r.columns.map((c) => cellText(c, row[c.key]))), numeric: r.columns.map((c) => c.type === 'number' || c.type === 'money') };
}

/** An Excel workbook (SpreadsheetML 2003, opened by Excel and LibreOffice) with one sheet per result. */
export function workbook(sheets: { name: string; result: QueryResult }[]): string {
  const ws = sheets.map(({ name, result }) => {
    const t = tableOf(result);
    const head = `<Row>${t.columns.map((c) => `<Cell ss:StyleID="h"><Data ss:Type="String">${esc(c.label)}</Data></Cell>`).join('')}</Row>`;
    const body = t.rows
      .map((row) => `<Row>${row.map((v, i) => (t.numeric[i] && v !== '' && !Number.isNaN(Number(v)) ? `<Cell><Data ss:Type="Number">${v}</Data></Cell>` : `<Cell><Data ss:Type="String">${esc(v)}</Data></Cell>`)).join('')}</Row>`)
      .join('');
    return `<Worksheet ss:Name="${esc(name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31))}"><Table>${head}${body}</Table></Worksheet>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="h"><Font ss:Bold="1"/></Style></Styles>${ws.join('')}</Workbook>`;
}

function htmlTable(r: QueryResult) {
  const t = tableOf(r);
  return `<table><tr>${t.columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr>${t.rows.map((row) => `<tr>${row.map((v, i) => `<td${t.numeric[i] ? ' style="text-align:right"' : ''}>${esc(v)}</td>`).join('')}</tr>`).join('')}</table>`;
}

/** The result as an HTML table, for Word and for scheduled emails. */
export function htmlReport(title: string, org: string, sections: { heading: string; result: QueryResult; note?: string }[]) {
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font-family:Calibri,Arial,sans-serif;font-size:10pt}h1{font-size:16pt}h2{font-size:12pt;margin-top:14pt}table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:3px 6px;text-align:left}th{background:#eef}</style></head><body><p>${esc(org)}</p><h1>${esc(title)}</h1>
${sections.map((s) => `<h2>${esc(s.heading)}</h2>${s.note ? `<p>${esc(s.note)}</p>` : ''}${htmlTable(s.result)}${s.result.truncated ? '<p>(First rows only.)</p>' : ''}`).join('\n')}
<p style="color:#777">Produced ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC.</p></body></html>`;
}

export async function exportResult(r: QueryResult, title: string, org: string, format: ExportFormat, note?: string): Promise<Response> {
  const base = safeName(title);
  if (format === 'csv') {
    const t = tableOf(r);
    return new Response(toCsv([t.columns.map((c) => c.label), ...t.rows]), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${base}.csv"` } });
  }
  if (format === 'xls') return new Response(workbook([{ name: title, result: r }]), { headers: { 'content-type': 'application/vnd.ms-excel', 'content-disposition': `attachment; filename="${base}.xls"` } });
  if (format === 'doc') return new Response(htmlReport(title, org, [{ heading: r.dataset.label, result: r, note }]), { headers: { 'content-type': 'application/msword', 'content-disposition': `attachment; filename="${base}.doc"` } });
  if (format === 'pptx') {
    const t = tableOf(r);
    const pages = Array.from({ length: Math.max(1, Math.ceil(Math.min(t.rows.length, 300) / 15)) }, (_, i) => t.rows.slice(i * 15, i * 15 + 15));
    const numeric = t.columns.findIndex((c, i) => i > 0 && t.numeric[i]);
    const chart = numeric > 0 && t.rows.length > 1 && t.rows.length <= 12 ? [{ title: `${title}: chart`, bars: t.rows.map((row) => ({ label: row[0], value: Number(row[numeric]) || 0 })), note: t.columns[numeric].label }] : [];
    const deck = pptx(title, [
      { title, subtitle: `${org} · ${r.dataset.label} · ${r.ranAt.toISOString().slice(0, 10)}`, bullets: [`${t.rows.length} rows`, ...(note ? [`Filters: ${note}`] : [])] },
      ...chart,
      ...pages.map((rows, i) => ({ title: pages.length > 1 ? `${title} (${i + 1} of ${pages.length})` : title, table: { head: t.columns.map((c) => c.label), rows } })),
    ]);
    return new Response(new Uint8Array(deck), { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'content-disposition': `attachment; filename="${base}.pptx"` } });
  }
  const t = tableOf(r);
  const width = 1 / t.columns.length;
  const pdf = await renderDocumentPdf({
    title,
    number: r.dataset.label,
    date: r.ranAt,
    stamp: null,
    issuer: { name: org, address: '', contact: '', taxId: '', branch: '' },
    party: null,
    facts: [['Rows', String(t.rows.length)], ...(note ? [['Filters', note] as [string, string]] : [])],
    tables: [{ columns: t.columns.map((c, i) => ({ label: c.label, width, align: t.numeric[i] ? ('right' as const) : ('left' as const) })), rows: t.rows.slice(0, 1500) }],
    signatures: [],
    footer: r.truncated || t.rows.length > 1500 ? 'Only the first rows are shown; export to Excel for all of them.' : undefined,
  });
  return new Response(new Uint8Array(pdf), { headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${base}.pdf"` } });
}

export { safeName };
