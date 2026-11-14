import { describe, expect, it } from 'vitest';
import { MANIFESTS } from '@/modules/manifests';
import { defineManifest, manifestProblems, resolvePermissions } from './manifest';

const sample = defineManifest({
  key: 'hr',
  name: 'HR',
  description: '',
  home: '/hr',
  permissions: { VIEW: 'hr.view', PAY: 'hr.payroll.run' },
  roles: { CLERK: { label: 'Clerk', permissions: ['hr.view'] } },
  nav: [{ href: '/hr', label: 'HR', permission: 'hr.view' }],
});

describe('module manifests', () => {
  it('every installed module is valid', () => {
    expect(manifestProblems(MANIFESTS)).toEqual([]);
  });

  it('catches clashes before they reach production', () => {
    const bad = { ...sample, key: 'users', permissions: { X: 'water.x' }, roles: { R: { label: 'R', permissions: ['hr.nope'] } }, nav: [{ href: '/other', label: 'x' }] };
    const problems = manifestProblems([bad, sample, sample]);
    expect(problems.join('\n')).toMatch(/reserved/);
    expect(problems.join('\n')).toMatch(/must start with "users\."/);
    expect(problems.join('\n')).toMatch(/unknown permission hr.nope/);
    expect(problems.join('\n')).toMatch(/must live under \/users/);
    expect(problems.join('\n')).toMatch(/installed twice/);
  });

  it('grants role permissions only in enabled modules; admins get all of them', () => {
    expect(resolvePermissions([sample], { isAdmin: false, access: [{ module: 'hr', role: 'CLERK' }] }, ['hr'])).toEqual(['hr.view']);
    expect(resolvePermissions([sample], { isAdmin: false, access: [{ module: 'hr', role: 'CLERK' }] }, [])).toEqual([]);
    expect(resolvePermissions([sample], { isAdmin: false, access: [{ module: 'hr', role: 'GONE' }] }, ['hr'])).toEqual([]);
    expect(resolvePermissions([sample], { isAdmin: true, access: [] }, ['hr'])).toEqual(expect.arrayContaining(['hr.view', 'hr.payroll.run', 'core.users.manage']));
  });
});
