import { describe, expect, it } from 'vitest';
import { safeNext } from './validation';

describe('safeNext', () => {
  it('keeps same-origin paths', () => {
    expect(safeNext('/journals')).toBe('/journals');
    expect(safeNext('/sales/invoices?status=OPEN#top')).toBe('/sales/invoices?status=OPEN#top');
  });

  it('sends anything that could leave the site to the home page', () => {
    for (const bad of ['//evil.test', '/\\evil.test', '/\\/evil.test', 'https://evil.test', 'evil.test', '/ok\\..\\evil', '/a b', '', null, undefined]) {
      expect(safeNext(bad)).toBe('/');
    }
  });
});
