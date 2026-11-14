import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pptx } from './pptx';
import { zip } from './zip';

/** Reads a ZIP's entries back (central directory), to check what zip() writes. */
function unzip(buf: Buffer) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString();
    const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    out[name] = inflateRawSync(buf.subarray(start, start + size)).toString();
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

describe('zip and pptx', () => {
  it('writes entries that read back exactly', () => {
    const files = unzip(zip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/b.xml', data: '<x>ü</x>' }]));
    expect(files).toEqual({ 'a.txt': 'hello', 'dir/b.xml': '<x>ü</x>' });
  });

  it('builds a deck with every part present and the text escaped', () => {
    const deck = pptx('Audit report', [
      { title: 'Revenue & billing <draft>', bullets: ['One', 'Two'] },
      { title: 'Table', table: { head: ['Ref', 'Finding'], rows: [['F1', 'Meters not read']] } },
      { title: 'Bars', bars: [{ label: 'High', value: 3 }, { label: 'Low', value: 1 }] },
    ]);
    expect(deck.subarray(0, 2).toString()).toBe('PK');
    const files = unzip(deck);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['[Content_Types].xml', 'ppt/presentation.xml', 'ppt/slides/slide1.xml', 'ppt/slides/slide3.xml', 'ppt/theme/theme1.xml']));
    expect(files['ppt/slides/slide1.xml']).toContain('Revenue &amp; billing &lt;draft&gt;');
    expect(files['ppt/slides/slide2.xml']).toContain('<a:tbl>');
    expect(files['ppt/presentation.xml'].match(/<p:sldId /g)).toHaveLength(3);
    for (const [name, xml] of Object.entries(files)) expect(xml.startsWith('<?xml'), name).toBe(true);
  });
});
