'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, Checkbox, ErrorBanner, Field, Input, Loading, Modal, PageHeader, TableWrap, Tabs } from '@/modules/finance/ui/components/ui';
import { api, errorMessage } from '@/modules/finance/ui/lib/api';
import { formatAmount, formatDateTime } from '@/modules/finance/ui/lib/format';
import { useBranches, useSession } from '@/modules/finance/ui/lib/session';
import type { Role, User } from '@/modules/finance/ui/lib/types';

interface UserForm {
  name: string;
  email: string;
  password: string;
  roleIds: string[];
  allBranches: boolean;
  branchIds: string[];
  approvalLimit: string;
  phone: string;
  isActive: boolean;
}

export default function UsersPage() {
  const { me } = useSession();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'users' | 'roles'>('users');
  const [editUser, setEditUser] = useState<{ id?: string; form: UserForm } | null>(null);
  const [editRole, setEditRole] = useState<{ id?: string; isSystem?: boolean; name: string; description: string; permissions: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: users = [], isLoading } = useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/users') });
  const { data: roles = [] } = useQuery({ queryKey: ['roles'], queryFn: () => api.get<Role[]>('/roles') });
  const { data: branches = [] } = useBranches();
  const catalog = Object.entries(me.permissionCatalog);

  const done = () => {
    setEditUser(null);
    setEditRole(null);
    setError(null);
    queryClient.invalidateQueries({ queryKey: ['users'] });
    queryClient.invalidateQueries({ queryKey: ['roles'] });
  };
  const saveUser = useMutation({
    mutationFn: ({ id, form }: { id?: string; form: UserForm }) => {
      const body = { ...form, approvalLimit: form.approvalLimit || null, password: form.password || undefined };
      if (id) {
        const { email: _email, ...rest } = body;
        return api.patch(`/users/${id}`, rest);
      }
      return api.post('/users', body);
    },
    onSuccess: done,
    onError: (err) => setError(errorMessage(err)),
  });
  const security = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'mfa/reset' | 'sessions/revoke' | 'invite' }) => api.post(`/users/${id}/${action}`),
    onSuccess: done,
    onError: (err) => setError(errorMessage(err)),
  });
  const saveRole = useMutation({
    mutationFn: (r: NonNullable<typeof editRole>) => {
      const body = { name: r.name, description: r.description, permissions: r.permissions };
      return r.id ? api.patch(`/roles/${r.id}`, body) : api.post('/roles', body);
    },
    onSuccess: done,
    onError: (err) => setError(errorMessage(err)),
  });

  const roleName = (id: string) => roles.find((r) => r.id === id)?.name;
  const toggle = (list: string[], v: string, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));
  const uf = editUser?.form;
  const setUf = (patch: Partial<UserForm>) => setEditUser((e) => (e ? { ...e, form: { ...e.form, ...patch } } : e));

  return (
    <>
      <PageHeader
        title="Users & roles"
        description="Roles grant permissions; branch restrictions and approval limits apply per user."
        actions={
          tab === 'users' ? (
            <Button
              variant="primary"
              onClick={() => {
                setError(null);
                setEditUser({ form: { name: '', email: '', password: '', roleIds: [], allBranches: true, branchIds: [], approvalLimit: '', phone: '', isActive: true } });
              }}
            >
              Add user
            </Button>
          ) : (
            <Button variant="primary" onClick={() => (setError(null), setEditRole({ name: '', description: '', permissions: [] }))}>
              New role
            </Button>
          )
        }
      />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'users', label: `Users (${users.length})` }, { id: 'roles', label: `Roles (${roles.length})` }]} />

      {tab === 'users' ? (
        <TableWrap>
          {isLoading ? (
            <Loading />
          ) : (
            <table className="table-base">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Roles</th>
                  <th>Branch access</th>
                  <th className="num">Approval limit</th>
                  <th>Last sign-in</th>
                  <th>Two-step</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className={u.isActive ? '' : 'opacity-50'}>
                    <td className="font-medium">
                      {u.name} {!u.isActive && <Badge tone="red">Inactive</Badge>}
                      {u.invitedAt && !u.passwordSetAt && <span className="ml-1"><Badge tone="amber">invited</Badge></span>}
                    </td>
                    <td className="text-muted">{u.email}</td>
                    <td className="space-x-1">{u.roleIds.map((r) => <Badge key={r}>{roleName(r)}</Badge>)}</td>
                    <td>
                      {u.allBranches ? (
                        <span className="text-muted">All branches</span>
                      ) : (
                        u.branchIds.map((b) => branches.find((x) => x.id === b)?.code).join(', ')
                      )}
                    </td>
                    <td className="num">{u.approvalLimit ? formatAmount(u.approvalLimit, 0) : <span className="text-muted">Unlimited</span>}</td>
                    <td className="text-xs text-muted">
                      {formatDateTime(u.lastLoginAt) || 'Never'}
                      {u.lockedUntil && new Date(u.lockedUntil) > new Date() && <span className="ml-1"><Badge tone="red">locked</Badge></span>}
                    </td>
                    <td>{u.mfa?.enabled ? <Badge tone="green">on</Badge> : <Badge tone={me.organisation.settings.requireMfa ? 'amber' : 'gray'}>{me.organisation.settings.requireMfa ? 'not set up' : 'off'}</Badge>}</td>
                    <td className="whitespace-nowrap text-right">
                      {u.invitedAt && !u.passwordSetAt && (
                        <Button size="sm" variant="ghost" onClick={() => security.mutate({ id: u.id, action: 'invite' })}>
                          Resend invitation
                        </Button>
                      )}
                      {u.mfa?.enabled && u.id !== me.id && (
                        <Button size="sm" variant="ghost" title="For a lost phone: they set it up again at next sign-in" onClick={() => security.mutate({ id: u.id, action: 'mfa/reset' })}>
                          Reset two-step
                        </Button>
                      )}
                      {u.id !== me.id && (
                        <Button size="sm" variant="ghost" onClick={() => security.mutate({ id: u.id, action: 'sessions/revoke' })}>
                          Sign out
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setError(null);
                          setEditUser({
                            id: u.id,
                            form: { name: u.name, email: u.email, password: '', roleIds: u.roleIds, allBranches: u.allBranches, branchIds: u.branchIds, approvalLimit: u.approvalLimit ?? '', phone: u.phone ?? '', isActive: u.isActive },
                          });
                        }}
                      >
                        Edit
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </TableWrap>
      ) : (
        <TableWrap>
          <table className="table-base">
            <thead>
              <tr>
                <th>Role</th>
                <th>Description</th>
                <th className="num">Users</th>
                <th>Permissions</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {roles.map((r) => (
                <tr key={r.id}>
                  <td className="font-medium">
                    {r.name} {r.isSystem && <Badge tone="blue">System</Badge>}
                  </td>
                  <td className="text-muted">{r.description}</td>
                  <td className="num">{r.userCount}</td>
                  <td className="text-xs text-muted">{r.permissions.length} of {catalog.length}</td>
                  <td className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => (setError(null), setEditRole({ ...r }))}>
                      Edit
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}

      <Modal
        wide
        open={!!editUser}
        onClose={() => setEditUser(null)}
        title={editUser?.id ? `Edit ${uf?.name}` : 'Add user'}
        footer={
          <>
            <Button onClick={() => setEditUser(null)}>Cancel</Button>
            <Button variant="primary" loading={saveUser.isPending} onClick={() => editUser && saveUser.mutate(editUser)}>
              Save user
            </Button>
          </>
        }
      >
        {uf && (
          <div className="space-y-4">
            <ErrorBanner error={error} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Name">
                <Input value={uf.name} onChange={(e) => setUf({ name: e.target.value })} />
              </Field>
              <Field label="Email">
                <Input type="email" disabled={!!editUser?.id} value={uf.email} onChange={(e) => setUf({ email: e.target.value })} />
              </Field>
              <Field label={editUser?.id ? 'Set a new password' : 'Password'} hint={editUser?.id ? 'Leave blank to keep; users can also reset their own from the sign-in page' : 'Leave blank to email an invitation, so they choose their own'}>
                <Input type="password" autoComplete="new-password" value={uf.password} placeholder={editUser?.id ? '' : 'Send an invitation'} onChange={(e) => setUf({ password: e.target.value })} />
              </Field>
            </div>
            <Field label="Roles">
              <div className="grid gap-2 pt-1 sm:grid-cols-3">
                {roles.map((r) => (
                  <Checkbox key={r.id} label={r.name} checked={uf.roleIds.includes(r.id)} onChange={(v) => setUf({ roleIds: toggle(uf.roleIds, r.id, v) })} />
                ))}
              </div>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Branch access">
                <div className="space-y-2 pt-1">
                  <Checkbox label="All branches" checked={uf.allBranches} onChange={(v) => setUf({ allBranches: v })} />
                  {!uf.allBranches && (
                    <div className="grid grid-cols-2 gap-1.5 rounded-md bg-gray-50 p-2">
                      {branches.map((b) => (
                        <Checkbox key={b.id} label={`${b.code} · ${b.name}`} checked={uf.branchIds.includes(b.id)} onChange={(v) => setUf({ branchIds: toggle(uf.branchIds, b.id, v) })} />
                      ))}
                    </div>
                  )}
                </div>
              </Field>
              <Field label="Journal approval limit" hint="In the journal's functional currency. Blank for unlimited.">
                <Input inputMode="decimal" value={uf.approvalLimit} onChange={(e) => setUf({ approvalLimit: e.target.value })} />
              </Field>
              <Field label="Mobile number" hint="For expense reimbursements by M-Pesa">
                <Input inputMode="tel" value={uf.phone} onChange={(e) => setUf({ phone: e.target.value })} placeholder="0712 345 678" />
              </Field>
            </div>
            {editUser?.id && <Checkbox label="Active" checked={uf.isActive} disabled={editUser.id === me.id} onChange={(v) => setUf({ isActive: v })} />}
          </div>
        )}
      </Modal>

      <Modal
        wide
        open={!!editRole}
        onClose={() => setEditRole(null)}
        title={editRole?.id ? `Edit role: ${editRole.name}` : 'New role'}
        footer={
          <>
            <Button onClick={() => setEditRole(null)}>Cancel</Button>
            <Button variant="primary" loading={saveRole.isPending} onClick={() => editRole && saveRole.mutate(editRole)}>
              Save role
            </Button>
          </>
        }
      >
        {editRole && (
          <div className="space-y-4">
            <ErrorBanner error={error} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name">
                <Input value={editRole.name} disabled={editRole.isSystem} onChange={(e) => setEditRole({ ...editRole, name: e.target.value })} />
              </Field>
              <Field label="Description">
                <Input value={editRole.description} onChange={(e) => setEditRole({ ...editRole, description: e.target.value })} />
              </Field>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {catalog.map(([key, label]) => (
                <Checkbox
                  key={key}
                  label={
                    <span>
                      {label} <span className="font-mono text-[11px] text-muted">{key}</span>
                    </span>
                  }
                  checked={editRole.permissions.includes(key)}
                  onChange={(v) => setEditRole({ ...editRole, permissions: toggle(editRole.permissions, key, v) })}
                />
              ))}
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
