import mongoose, { ClientSession, Connection, Model, Schema, Types } from 'mongoose';
import * as S from './schemas';
import { warehouseFactSchema } from './services/warehouse.service';
import * as W from './workflow-schemas';

/**
 * Registers a model on the connection once. Modules pass their own collection names (water_bills,
 * hr_payslips…) so every system lives in the one database without clashing.
 */
export function defineModel<T extends Schema>(conn: Connection, name: string, schema: T, collection?: string): Model<mongoose.InferSchemaType<T>> {
  return (conn.models[name] as Model<mongoose.InferSchemaType<T>>) ?? conn.model(name, schema, collection);
}

function coreModels(conn: Connection) {
  return {
    organisations: defineModel(conn, 'Organisation', S.organisationSchema, 'organisations'),
    users: defineModel(conn, 'User', S.userSchema, 'users'),
    counters: defineModel(conn, 'Counter', S.counterSchema, 'counters'),
    sms: defineModel(conn, 'SmsMessage', S.smsSchema, 'sms_messages'),
    audit: defineModel(conn, 'AuditLog', S.auditSchema, 'audit_logs'),
    accessLogs: defineModel(conn, 'AccessLog', S.accessLogSchema, 'access_logs'),
    warehouseFacts: defineModel(conn, 'WarehouseFact', warehouseFactSchema, 'warehouse_facts'),
    idempotency: defineModel(conn, 'IdempotencyKey', S.idempotencySchema, 'idempotency_keys'),
    emails: defineModel(conn, 'EmailMessage', W.emailSchema, 'email_messages'),
    documents: defineModel(conn, 'Document', W.documentSchema, 'documents'),
    notifications: defineModel(conn, 'Notification', W.notificationSchema, 'notifications'),
    tasks: defineModel(conn, 'Task', W.taskSchema, 'tasks'),
    approvalRules: defineModel(conn, 'ApprovalRule', W.approvalRuleSchema, 'approval_rules'),
    approvalRequests: defineModel(conn, 'ApprovalRequest', W.approvalRequestSchema, 'approval_requests'),
  };
}

export type CoreModels = ReturnType<typeof coreModels>;

export type Db = CoreModels & {
  connection: Connection;
  /** Runs `fn` in a transaction (MongoDB must be a replica set, e.g. Atlas). One transaction may touch any module. */
  transaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T>;
  /** Next value of a per-organisation sequence. Modules prefix the name with their key. */
  next(organisationId: Types.ObjectId, name: string, session?: ClientSession): Promise<number>;
};

export function createDb(conn: Connection): Db {
  const models = coreModels(conn);
  return {
    ...models,
    connection: conn,
    transaction: (fn) => conn.transaction(fn),
    async next(organisationId, name, session) {
      const doc = await models.counters.findOneAndUpdate({ organisationId, name }, { $inc: { value: 1 } }, { upsert: true, new: true, session });
      return doc!.value;
    },
  };
}

export async function openConnection(): Promise<Connection> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  return mongoose.createConnection(uri, { maxPoolSize: 10 }).asPromise();
}

/** Every model registered on the connection, core and modules alike. */
export async function syncAllIndexes(conn: Connection) {
  if (process.env.DB_SETUP_ON_START === 'false') return;
  await Promise.all(Object.values(conn.models).map((model) => model.syncIndexes()));
}
