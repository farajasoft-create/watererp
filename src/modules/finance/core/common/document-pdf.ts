import PDFDocument from 'pdfkit';
import { Types } from 'mongoose';
import { Db } from '../database/db.service';

const INK = '#1b1c2b';
const MUTED = '#5e6075';
const LINE = '#c9cad6';
const SHADE = '#f4f4f8';
export const pdfDay = (d: Date | null | undefined) => (d ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');

export interface Issuer {
  name: string;
  address: string;
  contact: string;
  taxId: string;
  branch: string;
}

export interface DocumentTable {
  heading?: string;
  /** Widths are fractions of the page width and should add up to 1. */
  columns: { label: string; width: number; align?: 'left' | 'right' | 'center' }[];
  rows: string[][];
  foot?: string[][];
}

export interface DocumentView {
  title: string;
  number: string;
  date: Date;
  /** Printed across the page (DRAFT, NOT APPROVED, CANCELLED …); null for a final document. */
  stamp: string | null;
  issuer: Issuer;
  /** The other party (supplier, department, store …). */
  party: { heading: string; name: string; lines: string[] } | null;
  facts: [string, string][];
  intro?: string;
  tables: DocumentTable[];
  sections?: { heading: string; text: string }[];
  /** Names and dates; `note` e.g. "Signed electronically". */
  signatures: { role: string; name: string; date: Date | null; note?: string }[];
  footer?: string;
}

/** The letterhead for an entity and branch. */
export async function issuerOf(db: Db, entityId: Types.ObjectId, branchId: Types.ObjectId | null): Promise<Issuer> {
  const [entity, branch] = await Promise.all([db.entities.findById(entityId).lean(), branchId ? db.branches.findById(branchId).lean() : null]);
  return {
    name: entity?.legalName || entity?.name || '',
    address: entity?.address ?? '',
    contact: [entity?.phone || branch?.phone, entity?.email || branch?.email].filter(Boolean).join(' · '),
    taxId: branch?.taxRegistrationNumber || entity?.taxId || '',
    branch: branch?.name ?? '',
  };
}

/**
 * A general A4 document (local purchase order, evaluation report, inspection certificate, store
 * voucher): letterhead and title bar, the party and key facts, ruled tables, text sections and a block
 * of signatures with names and dates. Built with PDFKit's built-in fonts.
 */
export async function renderDocumentPdf(v: DocumentView): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true, info: { Title: `${v.title} ${v.number}`, Author: v.issuer.name } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const right = left + width;
  const bottom = doc.page.height - 50;
  let y = 40;
  const room = (h: number) => {
    if (y + h > bottom) {
      doc.addPage();
      y = 40;
    }
  };
  const label = (text: string, x: number, at: number, w?: number) => doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5).text(text.toUpperCase(), x, at, { width: w });

  doc.fillColor(INK).font('Helvetica-Bold').fontSize(14).text(v.issuer.name, left, y, { width, align: 'center' });
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
  const head = [v.issuer.address, v.issuer.contact, v.issuer.taxId && `PIN ${v.issuer.taxId}`].filter(Boolean).join('  ·  ');
  if (head) doc.text(head, left, doc.y + 2, { width, align: 'center' });
  y = doc.y + 8;
  doc.rect(left, y, width, 24).fill(INK);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(13).text(v.title.toUpperCase(), left, y + 6, { width, align: 'center', characterSpacing: 1 });
  y += 32;

  const half = width / 2 - 6;
  const boxTop = y;
  let partyBottom = y;
  if (v.party) {
    label(v.party.heading, left + 8, y + 7);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(10.5).text(v.party.name, left + 8, y + 18, { width: half - 16 });
    if (v.party.lines.length) doc.font('Helvetica').fontSize(8.5).text(v.party.lines.filter(Boolean).join('\n'), left + 8, doc.y + 2, { width: half - 16 });
    partyBottom = doc.y + 8;
  }
  let fy = y + 7;
  for (const [k, val] of [['Number', v.number], ['Date', pdfDay(v.date)], ...v.facts] as [string, string][]) {
    doc.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(k, left + half + 20, fy, { width: 100 });
    doc.fillColor(INK).font(k === 'Number' ? 'Helvetica-Bold' : 'Helvetica').text(val || '—', left + half + 120, fy, { width: right - (left + half + 128), align: 'right' });
    fy = doc.y + 3;
  }
  y = Math.max(partyBottom, fy + 5);
  doc.rect(left, boxTop, width, y - boxTop).lineWidth(0.8).strokeColor(LINE).stroke();
  doc.moveTo(left + half + 12, boxTop).lineTo(left + half + 12, y).stroke();
  y += 12;

  if (v.intro) {
    doc.fillColor(INK).font('Helvetica').fontSize(9).text(v.intro, left, y, { width });
    y = doc.y + 10;
  }

  for (const t of v.tables) {
    const cols = t.columns.map((c) => ({ ...c, w: c.width * width }));
    if (t.heading) {
      room(40);
      label(t.heading, left, y);
      y += 12;
    }
    const drawHead = () => {
      doc.rect(left, y, width, 16).fill(SHADE);
      let x = left;
      for (const c of cols) {
        doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5).text(c.label.toUpperCase(), x + 4, y + 5, { width: c.w - 8, align: c.align ?? 'left' });
        x += c.w;
      }
      y += 18;
    };
    room(36);
    drawHead();
    const drawRow = (cells: string[], bold: boolean) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
      const h = Math.max(...cells.map((cell, i) => doc.heightOfString(cell || '', { width: cols[i].w - 8 }))) + 6;
      if (y + h > bottom) {
        doc.addPage();
        y = 40;
        drawHead();
      }
      let x = left;
      cells.forEach((cell, i) => {
        doc.fillColor(INK).font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5).text(cell || '', x + 4, y + 3, { width: cols[i].w - 8, align: cols[i].align ?? 'left' });
        x += cols[i].w;
      });
      y += h;
      doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(LINE).stroke();
    };
    for (const r of t.rows) drawRow(r, false);
    for (const r of t.foot ?? []) drawRow(r, true);
    y += 12;
  }

  for (const s of v.sections ?? []) {
    room(50);
    label(s.heading, left, y);
    doc.fillColor(INK).font('Helvetica').fontSize(9).text(s.text || '—', left, y + 11, { width });
    y = doc.y + 12;
  }

  if (v.signatures.length) {
    room(70);
    label('Signatures', left, y);
    y += 14;
    const per = 3;
    const w = (width - (per - 1) * 12) / per;
    for (let i = 0; i < v.signatures.length; i += per) {
      room(62);
      v.signatures.slice(i, i + per).forEach((s, j) => {
        const x = left + j * (w + 12);
        label(s.role, x, y, w);
        doc.fillColor(INK).font('Helvetica-Bold').fontSize(9).text(s.name || '', x, y + 11, { width: w });
        doc.font('Helvetica').fontSize(8).fillColor(MUTED).text([s.date ? pdfDay(s.date) : 'Date: ____________', s.note].filter(Boolean).join(' · '), x, y + 24, { width: w });
        doc.moveTo(x, y + 52).lineTo(x + w, y + 52).lineWidth(0.6).strokeColor(LINE).stroke();
      });
      y += 64;
    }
  }

  if (v.footer) {
    room(30);
    doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(7.5).text(v.footer, left, y, { width });
  }

  if (v.stamp) {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.save();
      doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc.fillColor('#c0392b').opacity(0.12).font('Helvetica-Bold').fontSize(64).text(v.stamp, 0, doc.page.height / 2 - 40, { width: doc.page.width, align: 'center' });
      doc.restore();
    }
  }
  doc.end();
  return done;
}
