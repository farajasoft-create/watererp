/**
 * Scaffolds a new module and registers it.
 *
 *   npm run module:new -- hr "HR & Payroll"
 *
 * Creates src/modules/<key> (manifest, models, services, routes, seed) and a first page at /<key>, then
 * adds the module to src/modules/manifests.ts and src/modules/server.ts. The sample "records" collection
 * is there to show the pattern end to end; rename or replace it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RESERVED_KEYS } from '../platform/manifest';

const [key, ...nameParts] = process.argv.slice(2);
const name = nameParts.join(' ').trim();
if (!key || !name) {
  console.error('Usage: npm run module:new -- <key> "<Name>"   e.g. npm run module:new -- hr "HR & Payroll"');
  process.exit(1);
}
if (!/^[a-z][a-z0-9]{1,19}$/.test(key) || RESERVED_KEYS.includes(key)) {
  console.error(`"${key}" cannot be a module key: use 2–20 lowercase letters or digits, not one of ${RESERVED_KEYS.join(', ')}`);
  process.exit(1);
}

const root = path.resolve(__dirname, '../..');
const moduleDir = path.join(root, 'src/modules', key);
const pageDir = path.join(root, 'src/app/(app)', key);
if (existsSync(moduleDir) || existsSync(pageDir)) {
  console.error(`src/modules/${key} or src/app/(app)/${key} already exists`);
  process.exit(1);
}

const Pascal = key[0].toUpperCase() + key.slice(1);
const quoted = JSON.stringify(name).slice(1, -1).replace(/'/g, "\\'");

const files: Record<string, string> = {
  [`src/modules/${key}/manifest.ts`]: `import { defineManifest } from '@/platform/manifest';

export const PERMISSIONS = {
  VIEW: '${key}.view',
  MANAGE: '${key}.manage',
} as const;

const P = PERMISSIONS;

export const ${key}Manifest = defineManifest({
  key: '${key}',
  name: '${quoted}',
  description: 'Describe what ${quoted} covers.',
  home: '/${key}',
  permissions: P,
  roles: {
    OFFICER: { label: 'Officer', permissions: [P.VIEW, P.MANAGE] },
    VIEWER: { label: 'Viewer', permissions: [P.VIEW] },
  },
  nav: [{ href: '/${key}', label: 'Records', permission: P.VIEW }],
});
`,
  [`src/modules/${key}/server/schemas.ts`]: `import { InferSchemaType, Schema, Types } from 'mongoose';

const { ObjectId } = Schema.Types;

export const recordSchema = new Schema(
  {
    organisationId: { type: ObjectId, required: true },
    number: { type: String, required: true },
    name: { type: String, required: true },
    notes: String,
    createdBy: ObjectId,
  },
  { timestamps: true },
);
recordSchema.index({ organisationId: 1, number: 1 }, { unique: true });

export type RecordDoc = InferSchemaType<typeof recordSchema> & { _id: Types.ObjectId };
`,
  [`src/modules/${key}/server/db.ts`]: `import { Connection } from 'mongoose';
import { Db, defineModel } from '@/platform/db';
import * as S from './schemas';

/** The ${key} module's collections, all prefixed ${key}_. */
export function ${key}Models(conn: Connection) {
  return {
    records: defineModel(conn, '${Pascal}Record', S.recordSchema, '${key}_records'),
  };
}

export type ${Pascal}Models = ReturnType<typeof ${key}Models>;
export type ${Pascal}Db = Db & ${Pascal}Models;
`,
  [`src/modules/${key}/server/records.service.ts`]: `import { Types } from 'mongoose';
import { AuthUser } from '@/platform/auth';
import { NotFoundException } from '@/platform/common/errors';
import { EventBus } from '@/platform/events';
import { AuditService } from '@/platform/services/audit.service';
import { ${Pascal}Db } from './db';

export class RecordsService {
  constructor(
    private readonly db: ${Pascal}Db,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  list(user: AuthUser) {
    return this.db.records.find({ organisationId: user.organisationId }).sort({ createdAt: -1 }).limit(200).lean();
  }

  async get(user: AuthUser, id: Types.ObjectId) {
    const record = await this.db.records.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!record) throw new NotFoundException('Record not found');
    return record;
  }

  async create(user: AuthUser, input: { name: string; notes?: string }) {
    const record = await this.db.transaction(async (session) => {
      const seq = await this.db.next(user.organisationId, '${key}:record', session);
      const [created] = await this.db.records.create([{ ...input, organisationId: user.organisationId, number: \`${key.toUpperCase()}-\${String(seq).padStart(5, '0')}\`, createdBy: user.id }], { session });
      await this.audit.record(user, '${key}.record.create', '${key}_record', created._id, input, session);
      return created.toObject();
    });
    await this.events.emit(user.organisationId, '${key}.record.created', { recordId: record._id });
    return record;
  }
}
`,
  [`src/modules/${key}/server/container.ts`]: `import type { CoreServices } from '@/platform/container';
import { ${Pascal}Db } from './db';
import { RecordsService } from './records.service';

/**
 * The ${key} module's services. Use core.ledger.post(...) for journals, core.sms.queue(...) for texts and
 * core.events to hear about (or tell) other modules.
 */
export function build${Pascal}Services(db: ${Pascal}Db, core: CoreServices) {
  return {
    db,
    records: new RecordsService(db, core.audit, core.events),
  };
}

export type ${Pascal}Services = ReturnType<typeof build${Pascal}Services>;
`,
  [`src/modules/${key}/server/route.ts`]: `import { routeFor } from '@/platform/http/route';
import type { ${Pascal}Services } from './container';

/** ${quoted} routes: handlers get the module's services as \`s\`. Paths are mounted under /api/v1/${key}. */
export const route = routeFor<${Pascal}Services>();
`,
  [`src/modules/${key}/server/routes.ts`]: `import { z } from 'zod';
import { parseId } from '@/platform/common/validation';
import { PERMISSIONS as P } from '../manifest';
import { route } from './route';

export const ${key}Routes = [
  route({ method: 'GET', path: '/records', permissions: [P.VIEW], handler: ({ s, user }) => s.records.list(user) }),
  route({ method: 'GET', path: '/records/:id', permissions: [P.VIEW], handler: ({ s, user, params }) => s.records.get(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/records',
    permissions: [P.MANAGE],
    body: z.object({ name: z.string().trim().min(1).max(150), notes: z.string().trim().max(1000).optional() }),
    handler: ({ s, user, body }) => s.records.create(user, body),
  }),
];
`,
  [`src/modules/${key}/module.ts`]: `import { defineModule } from '@/platform/module';
import { ${key}Manifest } from './manifest';
import { build${Pascal}Services, ${Pascal}Services } from './server/container';
import { ${key}Models, ${Pascal}Models } from './server/db';
import { ${key}Routes } from './server/routes';

export const ${key}Module = defineModule<${Pascal}Services, ${Pascal}Models>({
  manifest: ${key}Manifest,
  models: ${key}Models,
  services: ({ db, core }) => build${Pascal}Services(db, core),
  routes: ${key}Routes,
  // start: ({ core, services }) => { core.events.on('water.payment.posted', ...) },
  // seed: async ({ services, organisationId, demo }) => { ... },
});
`,
  [`src/modules/${key}/ui/api.ts`]: `import { moduleApi } from '@/lib/api';

export { ApiError, errorMessage } from '@/lib/api';

/** The ${quoted} API (/api/v1/${key}/*). */
export const api = moduleApi('${key}');
`,
  [`src/app/(app)/${key}/page.tsx`]: `'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, Card, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';
import { useCan } from '@/lib/session';
import { api } from '@/modules/${key}/ui/api';

interface RecordRow {
  id: string;
  number: string;
  name: string;
  notes?: string;
  createdAt: string;
}

export default function ${Pascal}Page() {
  const qc = useQueryClient();
  const can = useCan();
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ name: '', notes: '' });
  const { data, error, isLoading } = useQuery({ queryKey: ['${key}-records'], queryFn: () => api.get<RecordRow[]>('/records') });
  const create = useMutation({
    mutationFn: () => api.post('/records', { name: f.name, notes: f.notes || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['${key}-records'] });
      setCreating(false);
      setF({ name: '', notes: '' });
    },
  });

  return (
    <>
      <PageHeader title="${quoted}" subtitle="Records" actions={can('${key}.manage') && <Button onClick={() => setCreating(true)}>New record</Button>} />
      <ErrorBox error={error} />
      <Card padded={false}>
        {isLoading ? (
          <Loading />
        ) : !data?.length ? (
          <Empty>No records yet.</Empty>
        ) : (
          <table className="table-base">
            <thead><tr><th>Number</th><th>Name</th><th>Notes</th><th>Created</th></tr></thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}><td className="font-medium">{r.number}</td><td>{r.name}</td><td className="text-sm">{r.notes}</td><td>{fmtDateTime(r.createdAt)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {creating && (
        <Modal open onClose={() => setCreating(false)} title="New record" footer={<Button onClick={() => create.mutate()} disabled={create.isPending}>Save</Button>}>
          <ErrorBox error={create.error} />
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Notes"><Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        </Modal>
      )}
    </>
  );
}
`,
};

for (const [rel, content] of Object.entries(files)) {
  const file = path.join(root, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  console.log(`created ${rel}`);
}

function register(rel: string, importLine: string, listName: string, entry: string) {
  const file = path.join(root, rel);
  let src = readFileSync(file, 'utf8');
  const imports = [...src.matchAll(/^import .*;$/gm)];
  const last = imports[imports.length - 1];
  src = `${src.slice(0, last.index! + last[0].length)}\n${importLine}${src.slice(last.index! + last[0].length)}`;
  src = src.replace(new RegExp(`(${listName}[^=]*=\\s*\\[)([^\\]]*)\\]`), (_m, head: string, items: string) => `${head}${items.trim() ? `${items.trim()}, ` : ''}${entry}]`);
  writeFileSync(file, src);
  console.log(`registered in ${rel}`);
}

register('src/modules/manifests.ts', `import { ${key}Manifest } from './${key}/manifest';`, 'MANIFESTS', `${key}Manifest`);
register('src/modules/server.ts', `import { ${key}Module } from './${key}/module';`, 'SERVER_MODULES', `${key}Module`);

console.log(`
Done. Next:
  1. Switch "${name}" on under Settings → Modules (or SEED_MODULES=${key} npm run db:seed).
  2. Give users a role in it under Settings → Users & roles.
  3. Replace the sample records with the module's real collections, services, routes and pages.`);
