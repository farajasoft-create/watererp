import { z } from 'zod';
import { BadRequestException } from '../common/errors';
import { parseId, zDate, zId } from '../common/validation';
import { ATTACHMENT_CATEGORIES, ATTACHMENT_RECORD_TYPES } from '../database/governance.schemas';
import { route } from '../http/router';
import { MAX_ATTACHMENT_BYTES } from '../modules/documents/attachments.service';

export const attachmentRoutes = [
  route({
    method: 'GET',
    path: '/attachments',
    query: z.object({ recordType: z.enum(ATTACHMENT_RECORD_TYPES), recordId: zId }),
    handler: ({ s, user, query }) => s.attachments.list(user, query.recordType, query.recordId),
  }),
  route({
    method: 'GET',
    path: '/attachments/search',
    query: z.object({
      q: z.string().trim().max(100).optional(),
      recordType: z.enum(ATTACHMENT_RECORD_TYPES).optional(),
      category: z.enum(ATTACHMENT_CATEGORIES).optional(),
      from: zDate.optional(),
      to: zDate.optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }),
    handler: ({ s, user, query }) => s.attachments.search(user, query),
  }),
  /**
   * Upload: the request body is the raw file; metadata goes in the query string. At most 4 MB, so it fits
   * within serverless request limits.
   */
  route({
    method: 'POST',
    path: '/attachments',
    raw: true,
    rateLimit: 60,
    query: z.object({
      recordType: z.enum(ATTACHMENT_RECORD_TYPES),
      recordId: zId,
      name: z.string().trim().min(1).max(255),
      category: z.enum(ATTACHMENT_CATEGORIES).optional(),
      description: z.string().trim().max(500).optional(),
      replaces: zId.optional(),
    }),
    handler: async ({ s, user, query, req }) => {
      const declared = Number(req.headers.get('content-length') ?? 0);
      if (declared > MAX_ATTACHMENT_BYTES) throw new BadRequestException(`Files can be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`);
      const data = Buffer.from(await req.arrayBuffer());
      return s.attachments.upload(user, query, data);
    },
  }),
  /** Direct upload to object storage (R2): returns a signed URL to PUT the file to, valid 15 minutes. */
  route({
    method: 'POST',
    path: '/attachments/uploads',
    rateLimit: 60,
    body: z.object({
      recordType: z.enum(ATTACHMENT_RECORD_TYPES),
      recordId: zId,
      name: z.string().trim().min(1).max(255),
      size: z.number().int().positive(),
      category: z.enum(ATTACHMENT_CATEGORIES).optional(),
      description: z.string().trim().max(500).optional(),
      replaces: zId.nullable().optional(),
    }),
    handler: ({ s, user, body }) => s.attachments.createUpload(user, body),
  }),
  /** After the PUT: the server checks the stored file and makes it visible. */
  route({ method: 'POST', path: '/attachments/uploads/:id/complete', status: 200, handler: ({ s, user, params }) => s.attachments.completeUpload(user, parseId(params.id)) }),
  route({ method: 'GET', path: '/attachments/:id/versions', handler: ({ s, user, params }) => s.attachments.versions(user, parseId(params.id)) }),
  route({
    method: 'GET',
    path: '/attachments/:id/content',
    query: z.object({ inline: z.enum(['1', '0']).optional() }),
    handler: ({ s, user, params, query }) => s.attachments.download(user, parseId(params.id), query.inline === '1'),
  }),
  route({ method: 'DELETE', path: '/attachments/:id', handler: ({ s, user, params }) => s.attachments.remove(user, parseId(params.id)) }),
];
