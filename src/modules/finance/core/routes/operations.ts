import { Types } from 'mongoose';
import { z } from 'zod';
import { BadRequestException, NotFoundException } from '../common/errors';
import { toD128 } from '../common/money';
import { PERMISSIONS } from '../common/permissions';
import { parseId, zDate, zDecimal, zId, zLots } from '../common/validation';
import { Services } from '../container';
import { ASSET_ACQUISITION_TYPES, ASSET_CONDITIONS, DEPRECIATION_METHODS, ITEM_TRACKING, ITEM_TYPES, MAINTENANCE_KINDS } from '../database/operational.schemas';
import { route } from '../http/router';
import { pdf } from './getting-paid';
import { AuthUser } from '../common/auth';

const P = PERMISSIONS;
const code = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .regex(/^[A-Za-z0-9_-]+$/, 'Codes may contain letters, digits, - and _ only');
const reason = z.object({ reason: z.string().trim().max(500).optional() });

// ---------------------------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------------------------

const ItemBody = z.object({
  code,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).optional(),
  type: z.enum(ITEM_TYPES),
  category: z.string().trim().max(100).optional(),
  unit: z.string().trim().max(20).optional(),
  etimsClassCode: z.string().trim().regex(/^(\d{6,10})?$/, 'KRA item classification codes are 6 to 10 digits').optional(),
  inventoryAccountId: zId.nullable().optional(),
  cogsAccountId: zId.nullable().optional(),
  salesAccountId: zId.nullable().optional(),
  purchaseAccountId: zId.nullable().optional(),
  salesTaxCodeId: zId.nullable().optional(),
  purchaseTaxCodeId: zId.nullable().optional(),
  salesPrice: zDecimal.nullable().optional(),
  prices: z
    .array(z.object({ currency: z.string().trim().length(3).toUpperCase(), price: zDecimal }))
    .max(50)
    .refine((p) => new Set(p.map((x) => x.currency)).size === p.length, 'Enter one price per currency')
    .optional(),
  reorderLevel: zDecimal.nullable().optional(),
  reorderQty: zDecimal.nullable().optional(),
  valuation: z.enum(['AVERAGE', 'FIFO', 'LIFO']).optional(),
  categoryId: zId.nullable().optional(),
  barcode: z.string().trim().min(3).max(64).nullable().optional(),
  tracking: z.enum(ITEM_TRACKING).optional(),
  trackExpiry: z.boolean().optional(),
  isActive: z.boolean().optional(),
});
type ItemInput = z.infer<typeof ItemBody>;

async function validateItem(s: Services, user: AuthUser, body: Partial<ItemInput>, type: string) {
  const check = async (id: unknown, classes: string[], label: string) => {
    if (!id) return;
    const a = await s.db.accounts.findOne({ _id: id, organisationId: user.organisationId }).lean();
    if (!a?.isPostable || !classes.includes(a.accountClass) || !a.allowManualPosting) throw new BadRequestException(`${label} must be a postable ${classes.join('/').toLowerCase()} account`);
  };
  await check(body.inventoryAccountId, ['ASSET'], 'The inventory account');
  await check(body.cogsAccountId, ['COST_OF_SALES', 'EXPENSE'], 'The cost-of-sales account');
  await check(body.salesAccountId, ['REVENUE'], 'The sales account');
  await check(body.purchaseAccountId, ['EXPENSE', 'COST_OF_SALES', 'ASSET'], 'The purchase account');
  if (type === 'STOCK' && (body.inventoryAccountId === null || body.cogsAccountId === null)) throw new BadRequestException('Stock items need inventory and cost-of-sales accounts');
}

const itemDoc = ({ salesPrice, reorderLevel, reorderQty, code, prices, ...rest }: Partial<ItemInput>) => ({
  ...rest,
  ...(reorderQty !== undefined && { reorderQty: reorderQty ? toD128(reorderQty) : null }),
  ...(code && { code: code.toUpperCase() }),
  ...(prices && { prices: prices.map((p) => ({ currency: p.currency, price: toD128(p.price) })) }),
  ...(salesPrice !== undefined && { salesPrice: salesPrice ? toD128(salesPrice) : null }),
  ...(reorderLevel !== undefined && { reorderLevel: reorderLevel ? toD128(reorderLevel) : null }),
});

async function checkBarcode(s: Services, user: AuthUser, barcode: string | null | undefined, id?: Types.ObjectId) {
  if (!barcode) return;
  const other = await s.db.items.findOne({ organisationId: user.organisationId, barcode, ...(id && { _id: { $ne: id } }) }, { code: 1 }).lean();
  if (other) throw new BadRequestException(`Barcode ${barcode} is already on ${other.code}`);
}

const inventory = [
  route({
    method: 'GET',
    path: '/items',
    permissions: [P.INVENTORY_VIEW],
    query: z.object({ categoryId: zId.optional(), search: z.string().trim().max(100).optional() }),
    handler: ({ s, user, query }) => s.stockControl.items(user, query),
  }),
  route({ method: 'GET', path: '/items/by-code/:code', permissions: [P.INVENTORY_VIEW], handler: ({ s, user, params }) => s.stockControl.byBarcode(user, params.code) }),
  route({ method: 'GET', path: '/item-categories', permissions: [P.INVENTORY_VIEW], handler: ({ s, user }) => s.stockControl.categories(user) }),
  ...(['POST', 'PATCH'] as const).map((method) =>
    route({
      method,
      path: method === 'POST' ? '/item-categories' : '/item-categories/:id',
      permissions: [P.INVENTORY_MANAGE],
      body: z.object({ code, name: z.string().trim().min(1).max(100), parentId: zId.nullable().optional(), isActive: z.boolean().optional() }),
      handler: ({ s, user, body, params }) => s.stockControl.saveCategory(user, method === 'POST' ? null : parseId(params.id), body),
    }),
  ),
  route({ method: 'GET', path: '/inventory/dashboard', permissions: [P.INVENTORY_VIEW], query: z.object({ entityId: zId }), handler: ({ s, user, query }) => s.stockControl.dashboard(user, query.entityId) }),
  route({ method: 'POST', path: '/inventory/auto-requisition', permissions: [P.INVENTORY_MANAGE], body: z.object({ entityId: zId, branchId: zId, date: zDate }), handler: ({ s, user, body }) => s.stockControl.autoRequisition(user, body) }),
  route({
    method: 'POST',
    path: '/items',
    permissions: [P.INVENTORY_MANAGE],
    body: ItemBody,
    handler: async ({ s, user, body }) => {
      if (body.type === 'STOCK' && (!body.inventoryAccountId || !body.cogsAccountId)) throw new BadRequestException('Stock items need inventory and cost-of-sales accounts');
      await validateItem(s, user, body, body.type);
      await checkBarcode(s, user, body.barcode);
      const [item] = await s.db.items.create([{ ...itemDoc(body), ...(await s.stockControl.categoryFields(user.organisationId, body.categoryId)), organisationId: user.organisationId }]);
      await s.audit.log(user, { action: 'item.create', recordType: 'Item', recordId: item._id, summary: `Created item ${item.code} ${item.name}`, after: item });
      return item;
    },
  }),
  route({
    method: 'PATCH',
    path: '/items/:id',
    permissions: [P.INVENTORY_MANAGE],
    body: ItemBody.partial(),
    handler: async ({ s, user, body, params }) => {
      const before = await s.db.items.findOne({ _id: parseId(params.id), organisationId: user.organisationId }).lean();
      if (!before) throw new NotFoundException('Item not found');
      if (body.type && body.type !== before.type && (await s.db.stockMovements.exists({ organisationId: user.organisationId, itemId: before._id }))) {
        throw new BadRequestException('The type of an item with stock movements cannot change');
      }
      if (body.inventoryAccountId && before.inventoryAccountId && !body.inventoryAccountId.equals(before.inventoryAccountId) && (await s.db.stockBalances.exists({ organisationId: user.organisationId, itemId: before._id, quantity: { $ne: toD128(0) } }))) {
        throw new BadRequestException('Move the stock to zero before changing the inventory account');
      }
      if (body.valuation && body.valuation !== (before.valuation ?? 'AVERAGE') && (await s.db.stockBalances.exists({ organisationId: user.organisationId, itemId: before._id, quantity: { $ne: toD128(0) } }))) {
        throw new BadRequestException('Move the stock to zero before changing how the item is valued');
      }
      if (body.tracking && body.tracking !== (before.tracking ?? 'NONE') && (await s.db.stockBalances.exists({ organisationId: user.organisationId, itemId: before._id, quantity: { $ne: toD128(0) } }))) {
        throw new BadRequestException('Move the stock to zero before changing how the item is tracked');
      }
      await validateItem(s, user, body, body.type ?? before.type);
      await checkBarcode(s, user, body.barcode, before._id);
      const after = await s.db.items.findByIdAndUpdate(before._id, { ...itemDoc(body), ...(await s.stockControl.categoryFields(user.organisationId, body.categoryId)) }, { new: true }).lean();
      await s.audit.log(user, { action: 'item.update', recordType: 'Item', recordId: before._id, summary: `Updated item ${before.code}`, before, after });
      return after;
    },
  }),
  route({ method: 'GET', path: '/warehouses', permissions: [P.INVENTORY_VIEW], handler: ({ s, user }) => s.db.warehouses.find({ organisationId: user.organisationId }).sort({ code: 1 }).lean() }),
  route({
    method: 'POST',
    path: '/warehouses',
    permissions: [P.INVENTORY_MANAGE],
    body: z.object({ entityId: zId, branchId: zId, code, name: z.string().trim().min(1).max(200), isActive: z.boolean().optional() }),
    handler: async ({ s, user, body }) => {
      const branch = await s.db.branches.findOne({ _id: body.branchId, organisationId: user.organisationId, entityId: body.entityId }).lean();
      if (!branch) throw new BadRequestException('Branch not found in this entity');
      const [w] = await s.db.warehouses.create([{ ...body, code: body.code.toUpperCase(), organisationId: user.organisationId }]);
      await s.audit.log(user, { action: 'warehouse.create', recordType: 'Warehouse', recordId: w._id, summary: `Created warehouse ${w.code}`, after: w });
      return w;
    },
  }),
  route({
    method: 'PATCH',
    path: '/warehouses/:id',
    permissions: [P.INVENTORY_MANAGE],
    body: z.object({ name: z.string().trim().min(1).max(200).optional(), isActive: z.boolean().optional() }),
    handler: async ({ s, user, body, params }) => {
      const before = await s.db.warehouses.findOne({ _id: parseId(params.id), organisationId: user.organisationId }).lean();
      if (!before) throw new NotFoundException('Warehouse not found');
      const after = await s.db.warehouses.findByIdAndUpdate(before._id, body, { new: true }).lean();
      await s.audit.log(user, { action: 'warehouse.update', recordType: 'Warehouse', recordId: before._id, summary: `Updated warehouse ${before.code}`, before, after });
      return after;
    },
  }),
  route({
    method: 'GET',
    path: '/stock',
    permissions: [P.INVENTORY_VIEW],
    query: z.object({ entityId: zId, currency: z.string().trim().length(3).toUpperCase().optional(), date: zDate.optional() }),
    handler: ({ s, user, query }) => s.inventory.onHand(user, query.entityId, { currency: query.currency, date: query.date }),
  }),
  route({
    method: 'GET',
    path: '/stock/lots',
    permissions: [P.INVENTORY_VIEW],
    query: z.object({ entityId: zId, itemId: zId.optional(), warehouseId: zId.optional(), expiringWithinDays: z.coerce.number().int().min(0).max(3650).optional(), includeEmpty: z.enum(['true', 'false']).optional() }),
    handler: ({ s, user, query }) => s.inventory.lots(user, { ...query, includeEmpty: query.includeEmpty === 'true' }),
  }),
  route({
    method: 'GET',
    path: '/stock/trace',
    permissions: [P.INVENTORY_VIEW],
    query: z.object({ entityId: zId, number: z.string().trim().min(1).max(60), itemId: zId.optional() }),
    handler: ({ s, user, query }) => s.inventory.trace(user, query),
  }),
  route({
    method: 'GET',
    path: '/stock/movements',
    permissions: [P.INVENTORY_VIEW],
    query: z.object({ entityId: zId, itemId: zId.optional(), warehouseId: zId.optional(), from: zDate.optional(), to: zDate.optional() }),
    handler: ({ s, user, query }) => s.inventory.movements(user, query),
  }),
  route({ method: 'GET', path: '/stock/documents', permissions: [P.INVENTORY_VIEW], query: z.object({ entityId: zId.optional() }), handler: ({ s, user, query }) => s.inventory.listDocuments(user, query.entityId) }),
  route({ method: 'GET', path: '/stock/documents/:id', permissions: [P.INVENTORY_VIEW], handler: ({ s, user, params }) => s.inventory.getDocument(user, parseId(params.id)) }),
  ...(['POST', 'PATCH'] as const).map((method) =>
    route({
      method,
      path: method === 'POST' ? '/stock/documents' : '/stock/documents/:id',
      permissions: [P.INVENTORY_MANAGE],
      body: z.object({
        entityId: zId,
        kind: z.enum(['ADJUSTMENT', 'TRANSFER']),
        date: zDate,
        reason: z.string().trim().min(1).max(500),
        warehouseId: zId,
        toWarehouseId: zId.nullable().optional(),
        adjustmentAccountId: zId.nullable().optional(),
        lines: z.array(z.object({ itemId: zId, quantity: zDecimal, unitCost: zDecimal.nullable().optional(), lots: zLots })).min(1).max(500),
      }),
      handler: ({ s, user, body, params }) => (method === 'POST' ? s.inventory.createDocument(user, body) : s.inventory.updateDocument(user, parseId(params.id), body)),
    }),
  ),
  ...(['submit', 'approve', 'reject'] as const).map((action) =>
    route({
      method: 'POST',
      path: `/stock/documents/:id/${action}`,
      permissions: [action === 'submit' ? P.INVENTORY_MANAGE : P.INVENTORY_APPROVE],
      body: reason,
      handler: ({ s, user, params, body }) => s.inventory.actDocument(user, parseId(params.id), action, body.reason),
    }),
  ),
  route({ method: 'GET', path: '/landed-costs', permissions: [P.INVENTORY_VIEW], query: z.object({ entityId: zId.optional() }), handler: ({ s, user, query }) => s.landedCosts.list(user, query.entityId) }),
  route({ method: 'GET', path: '/landed-costs/receipts', permissions: [P.INVENTORY_VIEW], query: z.object({ entityId: zId }), handler: ({ s, user, query }) => s.landedCosts.receipts(user, query.entityId) }),
  route({ method: 'GET', path: '/landed-costs/:id', permissions: [P.INVENTORY_VIEW], handler: ({ s, user, params }) => s.landedCosts.get(user, parseId(params.id)) }),
  ...(['POST', 'PATCH'] as const).map((method) =>
    route({
      method,
      path: method === 'POST' ? '/landed-costs' : '/landed-costs/:id',
      permissions: [P.INVENTORY_MANAGE],
      body: z.object({
        entityId: zId,
        branchId: zId,
        date: zDate,
        description: z.string().trim().min(1).max(500),
        clearingAccountId: zId.nullable().optional(),
        amount: zDecimal,
        method: z.enum(['VALUE', 'QUANTITY']),
        receipts: z.array(z.object({ type: z.enum(['GoodsReceipt', 'Invoice']), id: zId })).min(1).max(100),
      }),
      handler: ({ s, user, body, params }) => (method === 'POST' ? s.landedCosts.create(user, body) : s.landedCosts.update(user, parseId(params.id), body)),
    }),
  ),
  route({ method: 'POST', path: '/landed-costs/:id/cancel', permissions: [P.INVENTORY_MANAGE], handler: ({ s, user, params }) => s.landedCosts.cancel(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/landed-costs/:id/post', permissions: [P.INVENTORY_APPROVE], handler: ({ s, user, params }) => s.landedCosts.post(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/landed-costs/:id/reverse',
    permissions: [P.INVENTORY_APPROVE],
    body: z.object({ date: zDate, reason: z.string().trim().min(3).max(500) }),
    handler: ({ s, user, params, body }) => s.landedCosts.reverse(user, parseId(params.id), body),
  }),
];

// ---------------------------------------------------------------------------------------------
// Fixed assets
// ---------------------------------------------------------------------------------------------

const CategoryBody = z.object({
  code,
  name: z.string().trim().min(1).max(200),
  assetAccountId: zId,
  accumulatedDepreciationAccountId: zId,
  depreciationExpenseAccountId: zId,
  disposalAccountId: zId,
  method: z.enum(DEPRECIATION_METHODS),
  usefulLifeMonths: z.number().int().min(1).max(1200),
  annualRatePercent: zDecimal.nullable().optional(),
  residualPercent: zDecimal.nullable().optional(),
  isActive: z.boolean().optional(),
});

const AssetDetailsBody = {
  tagNumber: z.string().trim().max(40).regex(/^[A-Za-z0-9._/-]*$/, 'Use letters, digits, dot, dash, slash or underscore').optional(),
  details: z
    .object({
      custodian: z.string().trim().max(120).optional(),
      condition: z.enum(ASSET_CONDITIONS).optional(),
      acquisitionType: z.enum(ASSET_ACQUISITION_TYPES).optional(),
      donor: z.string().trim().max(200).optional(),
      supplierName: z.string().trim().max(200).optional(),
      makeModel: z.string().trim().max(200).optional(),
      pvNumber: z.string().trim().max(60).optional(),
      deliveryDate: zDate.nullable().optional(),
      warranty: z.object({ provider: z.string().trim().max(200).optional(), expiresOn: zDate.nullable().optional(), terms: z.string().trim().max(500).optional() }).optional(),
      insurance: z
        .object({
          insurer: z.string().trim().max(200).optional(),
          policyNumber: z.string().trim().max(100).optional(),
          sumInsured: zDecimal.nullable().optional(),
          premium: zDecimal.nullable().optional(),
          startsOn: zDate.nullable().optional(),
          expiresOn: zDate.nullable().optional(),
        })
        .optional(),
    })
    .optional(),
};

const assets = [
  route({ method: 'GET', path: '/asset-categories', permissions: [P.ASSETS_VIEW], handler: ({ s, user }) => s.db.assetCategories.find({ organisationId: user.organisationId }).sort({ code: 1 }).lean() }),
  ...(['POST', 'PATCH'] as const).map((method) =>
    route({
      method,
      path: method === 'POST' ? '/asset-categories' : '/asset-categories/:id',
      permissions: [P.ASSETS_MANAGE],
      body: method === 'POST' ? CategoryBody : CategoryBody.partial(),
      handler: async ({ s, user, body, params }) => {
        const doc = {
          ...body,
          ...(body.code && { code: body.code.toUpperCase() }),
          ...(body.annualRatePercent !== undefined && { annualRatePercent: body.annualRatePercent ? toD128(body.annualRatePercent) : null }),
          ...(body.residualPercent !== undefined && { residualPercent: body.residualPercent ? toD128(body.residualPercent) : null }),
        };
        if (method === 'POST') {
          const [c] = await s.db.assetCategories.create([{ ...doc, organisationId: user.organisationId }]);
          await s.audit.log(user, { action: 'asset_category.create', recordType: 'AssetCategory', recordId: c._id, summary: `Created asset category ${c.code}` });
          return c;
        }
        const before = await s.db.assetCategories.findOne({ _id: parseId(params.id), organisationId: user.organisationId }).lean();
        if (!before) throw new NotFoundException('Category not found');
        const after = await s.db.assetCategories.findByIdAndUpdate(before._id, doc, { new: true }).lean();
        await s.audit.log(user, { action: 'asset_category.update', recordType: 'AssetCategory', recordId: before._id, summary: `Updated asset category ${before.code}`, before, after });
        return after;
      },
    }),
  ),
  route({ method: 'GET', path: '/assets', permissions: [P.ASSETS_VIEW], query: z.object({ entityId: zId, asOf: zDate }), handler: ({ s, user, query }) => s.assets.register(user, query.entityId, query.asOf) }),
  route({ method: 'GET', path: '/assets/care', permissions: [P.ASSETS_VIEW], query: z.object({ entityId: zId, days: z.coerce.number().int().min(0).max(366).default(60) }), handler: ({ s, user, query }) => s.assetCare.care(user, query) }),
  route({
    method: 'GET',
    path: '/assets/labels',
    permissions: [P.ASSETS_VIEW],
    rateLimit: 30,
    query: z.object({ entityId: zId, ids: z.string().max(5000).optional(), location: z.string().trim().max(200).optional(), skip: z.coerce.number().int().min(0).max(20).optional() }),
    handler: async ({ s, user, query }) => {
      const ids = query.ids ? query.ids.split(',').filter(Boolean).map((x) => parseId(x)) : undefined;
      return pdf(await s.assetCare.labels(user, { ...query, ids }), false);
    },
  }),
  route({ method: 'GET', path: '/assets/by-tag/:tag', permissions: [P.ASSETS_VIEW], handler: ({ s, user, params }) => s.assetCare.byTag(user, params.tag) }),
  route({
    method: 'POST',
    path: '/assets/verify',
    permissions: [P.ASSETS_VIEW],
    body: z.object({ tag: z.string().trim().min(1).max(40), location: z.string().trim().max(200).optional(), condition: z.enum(ASSET_CONDITIONS).optional(), date: zDate.optional() }),
    handler: ({ s, user, body }) => s.assetCare.verify(user, body),
  }),
  route({
    method: 'POST',
    path: '/assets/:id/maintenance',
    permissions: [P.ASSETS_MANAGE],
    body: z.object({ date: zDate, kind: z.enum(MAINTENANCE_KINDS), description: z.string().trim().min(1).max(500), vendor: z.string().trim().max(200).optional(), cost: zDecimal, invoiceId: zId.nullable().optional(), nextDue: zDate.nullable().optional() }),
    handler: ({ s, user, params, body }) => s.assetCare.addMaintenance(user, parseId(params.id), body),
  }),
  route({ method: 'DELETE', path: '/assets/:id/maintenance/:entryId', permissions: [P.ASSETS_MANAGE], handler: ({ s, user, params }) => s.assetCare.removeMaintenance(user, parseId(params.id), parseId(params.entryId)) }),
  route({ method: 'GET', path: '/assets/:id', permissions: [P.ASSETS_VIEW], handler: ({ s, user, params }) => s.assets.history(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/assets',
    permissions: [P.ASSETS_MANAGE],
    body: z.object({
      entityId: zId,
      branchId: zId,
      categoryId: zId,
      name: z.string().trim().min(1).max(200),
      description: z.string().trim().max(1000).optional(),
      serialNumber: z.string().trim().max(100).optional(),
      location: z.string().trim().max(200).optional(),
      departmentId: zId.nullable().optional(),
      projectId: zId.nullable().optional(),
      acquisitionDate: zDate,
      depreciationStart: zDate.nullable().optional(),
      cost: zDecimal,
      residualValue: zDecimal.nullable().optional(),
      usefulLifeMonths: z.number().int().min(1).max(1200).nullable().optional(),
      annualRatePercent: zDecimal.nullable().optional(),
      openingAccumulated: zDecimal.nullable().optional(),
      ...AssetDetailsBody,
      capitalisation: z.discriminatedUnion('mode', [
        z.object({ mode: z.literal('POST'), contraAccountId: zId }),
        z.object({ mode: z.literal('EXISTING'), sourceInvoiceId: zId.nullable().optional() }),
      ]),
    }),
    handler: ({ s, user, body }) => s.assets.create(user, body),
  }),
  route({
    method: 'PATCH',
    path: '/assets/:id',
    permissions: [P.ASSETS_MANAGE],
    body: z.object({
      name: z.string().trim().min(1).max(200).optional(),
      description: z.string().trim().max(1000).optional(),
      serialNumber: z.string().trim().max(100).optional(),
      location: z.string().trim().max(200).optional(),
      departmentId: zId.nullable().optional(),
      projectId: zId.nullable().optional(),
      ...AssetDetailsBody,
    }),
    handler: ({ s, user, params, body: { details, ...rest } }) => s.assets.update(user, parseId(params.id), { ...rest, ...details }),
  }),
  route({
    method: 'POST',
    path: '/assets/:id/transfer',
    permissions: [P.ASSETS_MANAGE],
    body: z.object({ date: zDate, branchId: zId, location: z.string().trim().max(200).optional() }),
    handler: ({ s, user, params, body }) => s.assets.transfer(user, parseId(params.id), body),
  }),
  route({
    method: 'POST',
    path: '/assets/:id/dispose',
    permissions: [P.ASSETS_DEPRECIATE],
    body: z.object({ date: zDate, proceeds: zDecimal, proceedsAccountId: zId.nullable().optional(), reason: z.string().trim().min(1).max(500) }),
    handler: ({ s, user, params, body }) => s.assets.dispose(user, parseId(params.id), body),
  }),
  route({
    method: 'GET',
    path: '/depreciation/preview',
    permissions: [P.ASSETS_VIEW],
    query: z.object({ entityId: zId, periodEnd: zDate }),
    handler: ({ s, user, query }) => s.assets.preview(user, query.entityId, query.periodEnd),
  }),
  route({ method: 'GET', path: '/depreciation/runs', permissions: [P.ASSETS_VIEW], query: z.object({ entityId: zId }), handler: ({ s, user, query }) => s.assets.runs(user, query.entityId) }),
  route({
    method: 'POST',
    path: '/depreciation/runs',
    permissions: [P.ASSETS_DEPRECIATE],
    body: z.object({ entityId: zId, periodEnd: zDate }),
    handler: ({ s, user, body }) => s.assets.run(user, body.entityId, body.periodEnd),
  }),
];

// ---------------------------------------------------------------------------------------------
// Expense claims
// ---------------------------------------------------------------------------------------------

const ClaimBody = z.object({
  entityId: zId,
  branchId: zId,
  title: z.string().trim().min(1).max(200),
  lines: z
    .array(
      z.object({
        date: zDate,
        categoryId: zId,
        description: z.string().trim().min(1).max(500),
        merchant: z.string().trim().max(200).optional(),
        receiptReference: z.string().trim().max(100).optional(),
        amount: zDecimal.nullable().optional(),
        currency: z.string().trim().length(3).toUpperCase().nullable().optional(),
        originalAmount: zDecimal.nullable().optional(),
        exchangeRate: zDecimal.nullable().optional(),
        taxCodeId: zId.nullable().optional(),
        departmentId: zId.nullable().optional(),
        projectId: zId.nullable().optional(),
      }),
    )
    .min(1)
    .max(100),
});

const expenses = [
  route({ method: 'GET', path: '/expense-categories', handler: ({ s, user }) => s.db.expenseCategories.find({ organisationId: user.organisationId }).sort({ code: 1 }).lean() }),
  ...(['POST', 'PATCH'] as const).map((method) =>
    route({
      method,
      path: method === 'POST' ? '/expense-categories' : '/expense-categories/:id',
      permissions: [P.COA_MANAGE],
      body: z.object({ code, name: z.string().trim().min(1).max(200), accountId: zId, taxCodeId: zId.nullable().optional(), limitPerLine: zDecimal.nullable().optional(), requiresReceipt: z.boolean().optional(), isActive: z.boolean().optional() }).partial(),
      handler: async ({ s, user, body, params }) => {
        const doc = { ...body, ...(body.code && { code: body.code.toUpperCase() }), ...(body.limitPerLine !== undefined && { limitPerLine: body.limitPerLine ? toD128(body.limitPerLine) : null }) };
        if (method === 'POST') {
          if (!body.code || !body.name || !body.accountId) throw new BadRequestException('Code, name and account are required');
          const [c] = await s.db.expenseCategories.create([{ ...doc, organisationId: user.organisationId }]);
          return c;
        }
        const after = await s.db.expenseCategories.findOneAndUpdate({ _id: parseId(params.id), organisationId: user.organisationId }, doc, { new: true }).lean();
        if (!after) throw new NotFoundException('Category not found');
        return after;
      },
    }),
  ),
  route({
    method: 'GET',
    path: '/expense-claims',
    permissions: [P.EXPENSES_SUBMIT],
    query: z.object({ entityId: zId.optional(), status: z.string().max(20).optional(), mine: z.enum(['true', 'false']).optional() }),
    handler: ({ s, user, query }) => s.expenses.list(user, { ...query, mine: query.mine === 'true' }),
  }),
  route({ method: 'GET', path: '/expense-claims/:id', permissions: [P.EXPENSES_SUBMIT], handler: ({ s, user, params }) => s.expenses.get(user, parseId(params.id)) }),
  route({ method: 'GET', path: '/expense-claims/:id/voucher', permissions: [P.EXPENSES_SUBMIT], rateLimit: 60, handler: async ({ s, user, params }) => pdf(await s.vouchers.claimPayment(user, parseId(params.id)), false) }),
  route({ method: 'POST', path: '/expense-claims', permissions: [P.EXPENSES_SUBMIT], body: ClaimBody, handler: ({ s, user, body }) => s.expenses.create(user, body) }),
  route({ method: 'PATCH', path: '/expense-claims/:id', permissions: [P.EXPENSES_SUBMIT], body: ClaimBody, handler: ({ s, user, params, body }) => s.expenses.update(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/expense-claims/:id/submit', permissions: [P.EXPENSES_SUBMIT], handler: ({ s, user, params }) => s.expenses.submit(user, parseId(params.id)) }),
  route({
    method: 'POST',
    path: '/expense-claims/:id/approve',
    permissions: [P.EXPENSES_APPROVE],
    body: z.object({ comment: z.string().trim().max(500).optional() }),
    handler: ({ s, user, params, body }) => s.expenses.approve(user, parseId(params.id), body.comment),
  }),
  route({
    method: 'POST',
    path: '/expense-claims/:id/reject',
    permissions: [P.EXPENSES_APPROVE],
    body: z.object({ reason: z.string().trim().min(1, 'A reason is required').max(500) }),
    handler: ({ s, user, params, body }) => s.expenses.reject(user, parseId(params.id), body.reason),
  }),
  route({
    method: 'POST',
    path: '/expense-claims/:id/pay',
    permissions: [P.EXPENSES_PAY],
    body: z.object({ date: zDate, bankAccountId: zId, reference: z.string().trim().max(100).optional() }),
    handler: ({ s, user, params, body }) => s.expenses.pay(user, parseId(params.id), body),
  }),
];

// ---------------------------------------------------------------------------------------------
// Budgets, budget vs actual and projects
// ---------------------------------------------------------------------------------------------

const BudgetBody = z.object({
  entityId: zId,
  fiscalYearId: zId,
  name: z.string().trim().min(1).max(200),
  kind: z.enum(['BUDGET', 'FORECAST']),
  notes: z.string().trim().max(2000).optional(),
  lines: z
    .array(z.object({ accountId: zId, branchId: zId.nullable().optional(), departmentId: zId.nullable().optional(), projectId: zId.nullable().optional(), amounts: z.array(zDecimal).min(1).max(24) }))
    .max(2000),
});

const budgets = [
  route({ method: 'GET', path: '/budgets', permissions: [P.BUDGETS_VIEW], query: z.object({ entityId: zId.optional() }), handler: ({ s, user, query }) => s.budgets.list(user, query.entityId) }),
  route({
    method: 'GET',
    path: '/budgets/from-actuals',
    permissions: [P.BUDGETS_MANAGE],
    query: z.object({ entityId: zId, fiscalYearId: zId, upliftPercent: zDecimal.default('0') }),
    handler: ({ s, user, query }) => s.budgets.fromActuals(user, query),
  }),
  route({ method: 'GET', path: '/budgets/:id', permissions: [P.BUDGETS_VIEW], handler: ({ s, user, params }) => s.budgets.get(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/budgets', permissions: [P.BUDGETS_MANAGE], body: BudgetBody, handler: ({ s, user, body }) => s.budgets.create(user, body) }),
  route({ method: 'PATCH', path: '/budgets/:id', permissions: [P.BUDGETS_MANAGE], body: BudgetBody, handler: ({ s, user, params, body }) => s.budgets.update(user, parseId(params.id), body) }),
  ...(['submit', 'approve', 'reject'] as const).map((action) =>
    route({
      method: 'POST',
      path: `/budgets/:id/${action}`,
      permissions: [action === 'submit' ? P.BUDGETS_MANAGE : P.BUDGETS_APPROVE],
      body: reason,
      handler: ({ s, user, params, body }) => s.budgets.act(user, parseId(params.id), action, body.reason),
    }),
  ),
  route({
    method: 'GET',
    path: '/reports/budget-vs-actual',
    permissions: [P.BUDGETS_VIEW],
    query: z.object({ entityId: zId, budgetId: zId.optional(), from: zDate, to: zDate, branchId: zId.optional(), departmentId: zId.optional(), projectId: zId.optional() }),
    handler: ({ s, user, query }) => s.budgets.vsActual(user, query),
  }),
  route({
    method: 'GET',
    path: '/budget-balances',
    permissions: [P.BUDGETS_VIEW],
    query: z.object({ entityId: zId, asOf: zDate, departmentId: zId.optional() }),
    handler: ({ s, user, query }) => s.budgetPlanning.balances(user, query),
  }),
  route({
    method: 'GET',
    path: '/reports/projects',
    permissions: [P.REPORTS_VIEW],
    query: z.object({ entityId: zId, asOf: zDate }),
    handler: ({ s, user, query }) => s.budgets.projects(user, query.entityId, query.asOf),
  }),
];

// ---------------------------------------------------------------------------------------------
// Budget preparation: department submissions, consolidation and in-year changes
// ---------------------------------------------------------------------------------------------

const SubmissionBody = z.object({
  entityId: zId,
  fiscalYearId: zId,
  departmentId: zId,
  title: z.string().trim().min(1).max(200),
  objectives: z.string().trim().max(4000).optional(),
  workplan: z
    .array(
      z.object({
        activity: z.string().trim().min(1).max(300),
        output: z.string().trim().max(300).optional(),
        indicator: z.string().trim().max(300).optional(),
        target: z.string().trim().max(200).optional(),
        quarters: z.array(z.number().int().min(1).max(4)).max(4).optional(),
        cost: zDecimal,
      }),
    )
    .max(200),
  lines: z.array(z.object({ accountId: zId, branchId: zId.nullable().optional(), projectId: zId.nullable().optional(), amounts: z.array(zDecimal).min(1).max(24) })).max(500),
});

const ChangeBody = z.object({
  budgetId: zId,
  date: zDate,
  kind: z.enum(['REALLOCATION', 'SUPPLEMENTARY', 'REDUCTION']),
  reason: z.string().trim().min(1, 'Give the reason for the change').max(1000),
  lines: z
    .array(z.object({ accountId: zId, branchId: zId.nullable().optional(), departmentId: zId.nullable().optional(), projectId: zId.nullable().optional(), period: z.number().int().min(0).max(23), change: zDecimal }))
    .min(1)
    .max(200),
});

const StoreRequisitionBody = z.object({
  entityId: zId,
  kind: z.enum(['ISSUE', 'BRANCH']),
  date: zDate,
  purpose: z.string().trim().min(1).max(500),
  warehouseId: zId,
  toWarehouseId: zId.nullable().optional(),
  departmentId: zId.nullable().optional(),
  lines: z.array(z.object({ itemId: zId, quantity: zDecimal, accountId: zId.nullable().optional() })).min(1).max(200),
});
const QtyLines = z.array(z.object({ lineNo: z.number().int().positive(), quantity: zDecimal })).max(200);

const storeRequisitions = [
  route({
    method: 'GET',
    path: '/store-requisitions',
    permissions: [P.INVENTORY_VIEW],
    query: z.object({ entityId: zId, status: z.string().max(20).optional(), kind: z.enum(['ISSUE', 'BRANCH']).optional() }),
    handler: ({ s, user, query }) => s.storeRequisitions.list(user, query),
  }),
  route({ method: 'GET', path: '/store-requisitions/:id', permissions: [P.INVENTORY_VIEW], handler: ({ s, user, params }) => s.storeRequisitions.get(user, parseId(params.id)) }),
  route({
    method: 'GET',
    path: '/store-requisitions/:id/voucher',
    permissions: [P.INVENTORY_VIEW],
    handler: async ({ s, user, params }) => pdf(await s.storeRequisitions.voucher(user, parseId(params.id)), false),
  }),
  route({ method: 'POST', path: '/store-requisitions', permissions: [P.PROCUREMENT_REQUEST], body: StoreRequisitionBody, handler: ({ s, user, body }) => s.storeRequisitions.create(user, body) }),
  route({
    method: 'POST',
    path: '/store-requisitions/counter-issue',
    permissions: [P.INVENTORY_MANAGE],
    body: StoreRequisitionBody.extend({ collectedBy: z.string().trim().min(1, 'Record who collected the items').max(200) }),
    handler: ({ s, user, body }) => {
      const { collectedBy, ...rest } = body;
      return s.storeRequisitions.create(user, rest, { collectedBy });
    },
  }),
  route({ method: 'PATCH', path: '/store-requisitions/:id', permissions: [P.PROCUREMENT_REQUEST], body: StoreRequisitionBody, handler: ({ s, user, params, body }) => s.storeRequisitions.update(user, parseId(params.id), body) }),
  ...(['submit', 'approve', 'reject', 'cancel'] as const).map((action) =>
    route({
      method: 'POST',
      path: `/store-requisitions/:id/${action}`,
      permissions: [action === 'approve' || action === 'reject' ? P.INVENTORY_APPROVE : P.PROCUREMENT_REQUEST],
      body: z.object({ reason: z.string().trim().max(500).optional(), approved: QtyLines.optional() }),
      handler: ({ s, user, params, body }) => s.storeRequisitions.act(user, parseId(params.id), action, body),
    }),
  ),
  route({
    method: 'POST',
    path: '/store-requisitions/:id/issue',
    permissions: [P.INVENTORY_MANAGE],
    body: z.object({ date: zDate, collectedBy: z.string().trim().max(200).optional(), reference: z.string().trim().max(100).optional(), lines: QtyLines.min(1) }),
    handler: ({ s, user, params, body }) => s.storeRequisitions.issue(user, parseId(params.id), body),
  }),
  route({
    method: 'POST',
    path: '/store-requisitions/:id/issue-scan',
    permissions: [P.INVENTORY_MANAGE],
    body: z.object({ date: zDate, collectedBy: z.string().trim().max(200).optional(), reference: z.string().trim().max(100).optional(), scans: z.array(z.object({ code: z.string().trim().min(1).max(64), quantity: zDecimal.optional() })).min(1).max(500) }),
    handler: ({ s, user, params, body }) => s.stockControl.issueByScan(user, parseId(params.id), body),
  }),
  route({
    method: 'POST',
    path: '/store-requisitions/:id/receive',
    permissions: [P.INVENTORY_MANAGE],
    body: z.object({ date: zDate, notes: z.string().trim().max(1000).optional(), lossAccountId: zId.nullable().optional(), lines: QtyLines }),
    handler: ({ s, user, params, body }) => s.storeRequisitions.receive(user, parseId(params.id), body),
  }),
];

const ProgrammeBody = z.object({
  code,
  name: z.string().trim().min(1).max(200),
  entityId: zId.nullable().optional(),
  parentId: zId.nullable().optional(),
  objective: z.string().trim().max(2000).optional(),
  outcome: z.string().trim().max(2000).optional(),
  departmentIds: z.array(zId).max(200).optional(),
  projectIds: z.array(zId).max(200).optional(),
  kpis: z.array(z.object({ id: zId.nullable().optional(), indicator: z.string().trim().min(1).max(300), unit: z.string().trim().max(60).optional(), baseline: z.string().trim().max(60).optional(), target: z.string().trim().max(60).optional() })).max(50).optional(),
  isActive: z.boolean().optional(),
});

const programmes = [
  route({ method: 'GET', path: '/programmes', permissions: [P.BUDGETS_VIEW], handler: ({ s, user }) => s.programmes.list(user) }),
  route({
    method: 'GET',
    path: '/reports/programmes',
    permissions: [P.BUDGETS_VIEW],
    query: z.object({ entityId: zId, fiscalYearId: zId }),
    handler: ({ s, user, query }) => s.programmes.report(user, query),
  }),
  route({ method: 'POST', path: '/programmes', permissions: [P.BUDGETS_MANAGE], body: ProgrammeBody, handler: ({ s, user, body }) => s.programmes.save(user, null, body) }),
  route({ method: 'PATCH', path: '/programmes/:id', permissions: [P.BUDGETS_MANAGE], body: ProgrammeBody, handler: ({ s, user, params, body }) => s.programmes.save(user, parseId(params.id), body) }),
  route({
    method: 'POST',
    path: '/programmes/:id/kpis/:kpiId',
    permissions: [P.BUDGETS_MANAGE],
    body: z.object({ fiscalYearId: zId, quarter: z.number().int().min(1).max(4), value: z.string().trim().min(1).max(60), note: z.string().trim().max(500).optional() }),
    handler: ({ s, user, params, body }) => s.programmes.reportKpi(user, parseId(params.id), parseId(params.kpiId), body),
  }),
];

const budgetPlanning = [
  ...programmes,
  route({
    method: 'GET',
    path: '/budget-submissions',
    permissions: [P.BUDGETS_VIEW],
    query: z.object({ entityId: zId, fiscalYearId: zId.optional(), departmentId: zId.optional() }),
    handler: ({ s, user, query }) => s.budgetPlanning.listSubmissions(user, query),
  }),
  route({
    method: 'GET',
    path: '/budget-submissions/template',
    permissions: [P.BUDGETS_MANAGE],
    query: z.object({ entityId: zId, fiscalYearId: zId, departmentId: zId }),
    handler: ({ s, user, query }) => s.budgetPlanning.template(user, query),
  }),
  route({
    method: 'GET',
    path: '/budget-submissions/consolidation',
    permissions: [P.BUDGETS_VIEW],
    query: z.object({ entityId: zId, fiscalYearId: zId }),
    handler: ({ s, user, query }) => s.budgetPlanning.consolidation(user, query),
  }),
  route({
    method: 'POST',
    path: '/budget-submissions/consolidate',
    permissions: [P.BUDGETS_MANAGE],
    body: z.object({ entityId: zId, fiscalYearId: zId, name: z.string().trim().min(1).max(200), submissionIds: z.array(zId).max(500).optional(), notes: z.string().trim().max(2000).optional() }),
    handler: ({ s, user, body }) => s.budgetPlanning.consolidate(user, body),
  }),
  route({ method: 'GET', path: '/budget-submissions/:id', permissions: [P.BUDGETS_VIEW], handler: ({ s, user, params }) => s.budgetPlanning.getSubmission(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/budget-submissions', permissions: [P.BUDGETS_MANAGE], body: SubmissionBody, handler: ({ s, user, body }) => s.budgetPlanning.saveSubmission(user, null, body) }),
  route({
    method: 'PATCH',
    path: '/budget-submissions/:id',
    permissions: [P.BUDGETS_MANAGE],
    body: SubmissionBody,
    handler: ({ s, user, params, body }) => s.budgetPlanning.saveSubmission(user, parseId(params.id), body),
  }),
  ...(['submit', 'approve', 'reject'] as const).map((action) =>
    route({
      method: 'POST',
      path: `/budget-submissions/:id/${action}`,
      permissions: [action === 'submit' ? P.BUDGETS_MANAGE : P.BUDGETS_APPROVE],
      body: reason,
      handler: ({ s, user, params, body }) => s.budgetPlanning.actSubmission(user, parseId(params.id), action, body.reason),
    }),
  ),
  route({
    method: 'GET',
    path: '/budget-changes',
    permissions: [P.BUDGETS_VIEW],
    query: z.object({ entityId: zId, budgetId: zId.optional() }),
    handler: ({ s, user, query }) => s.budgetPlanning.listChanges(user, query),
  }),
  route({ method: 'GET', path: '/budget-changes/:id', permissions: [P.BUDGETS_VIEW], handler: ({ s, user, params }) => s.budgetPlanning.getChange(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/budget-changes', permissions: [P.BUDGETS_MANAGE], body: ChangeBody, handler: ({ s, user, body }) => s.budgetPlanning.saveChange(user, null, body) }),
  route({
    method: 'PATCH',
    path: '/budget-changes/:id',
    permissions: [P.BUDGETS_MANAGE],
    body: ChangeBody,
    handler: ({ s, user, params, body }) => s.budgetPlanning.saveChange(user, parseId(params.id), body),
  }),
  ...(['submit', 'approve', 'reject', 'cancel'] as const).map((action) =>
    route({
      method: 'POST',
      path: `/budget-changes/:id/${action}`,
      permissions: [action === 'approve' || action === 'reject' ? P.BUDGETS_APPROVE : P.BUDGETS_MANAGE],
      body: reason,
      handler: ({ s, user, params, body }) => s.budgetPlanning.actChange(user, parseId(params.id), action, body.reason),
    }),
  ),
];

// ---------------------------------------------------------------------------------------------
// Staff imprest
// ---------------------------------------------------------------------------------------------

const ImprestBody = z.object({
  entityId: zId,
  branchId: zId,
  typeId: zId,
  purpose: z.string().trim().min(1).max(300),
  destination: z.string().trim().max(200).optional(),
  startDate: zDate,
  endDate: zDate,
  departmentId: zId.nullable().optional(),
  projectId: zId.nullable().optional(),
  lines: z.array(z.object({ description: z.string().trim().min(1).max(300), amount: zDecimal })).min(1).max(50),
});
const SurrenderBody = z.object({
  date: zDate,
  lines: z
    .array(
      z.object({
        date: zDate,
        categoryId: zId,
        description: z.string().trim().min(1).max(500),
        receiptReference: z.string().trim().max(100).optional(),
        amount: zDecimal,
        departmentId: zId.nullable().optional(),
        projectId: zId.nullable().optional(),
      }),
    )
    .max(100),
  cashReturned: zDecimal.nullable().optional(),
  refundBankAccountId: zId.nullable().optional(),
  refundReference: z.string().trim().max(100).optional(),
  notes: z.string().trim().max(1000).optional(),
});
const comment = z.object({ comment: z.string().trim().max(500).optional() });
const required = z.object({ reason: z.string().trim().min(1, 'A reason is required').max(500) });

const imprest = [
  route({ method: 'GET', path: '/imprest-types', permissions: [P.EXPENSES_SUBMIT], handler: ({ s, user }) => s.imprest.types(user.organisationId) }),
  ...(['POST', 'PATCH'] as const).map((method) =>
    route({
      method,
      path: method === 'POST' ? '/imprest-types' : '/imprest-types/:id',
      permissions: [P.EXPENSES_PAY],
      body: z.object({ code, name: z.string().trim().min(1).max(200), description: z.string().trim().max(500), maxAmount: zDecimal.nullable(), surrenderDays: z.number().int().min(0).max(365), isActive: z.boolean() }).partial(),
      handler: ({ s, user, body, params }) => s.imprest.saveType(user, method === 'POST' ? null : parseId(params.id), body),
    }),
  ),
  route({
    method: 'GET',
    path: '/imprests',
    permissions: [P.EXPENSES_SUBMIT],
    query: z.object({ entityId: zId.optional(), status: z.string().max(30).optional(), mine: z.enum(['true', 'false']).optional(), overdue: z.enum(['true', 'false']).optional() }),
    handler: ({ s, user, query }) => s.imprest.list(user, { ...query, mine: query.mine === 'true', overdue: query.overdue === 'true' }),
  }),
  route({
    method: 'GET',
    path: '/imprests/outstanding',
    permissions: [P.EXPENSES_PAY],
    query: z.object({ entityId: zId }),
    handler: ({ s, user, query }) => s.imprest.outstandingReport(user, query.entityId),
  }),
  route({
    method: 'POST',
    path: '/imprests/remind-overdue',
    permissions: [P.EXPENSES_PAY],
    handler: ({ s, user }) => s.imprest.remindOverdue(new Date(), { organisationId: user.organisationId }),
  }),
  route({ method: 'GET', path: '/imprests/:id', permissions: [P.EXPENSES_SUBMIT], handler: ({ s, user, params }) => s.imprest.get(user, parseId(params.id)) }),
  route({ method: 'GET', path: '/imprests/:id/voucher', permissions: [P.EXPENSES_SUBMIT], rateLimit: 60, handler: async ({ s, user, params }) => pdf(await s.vouchers.imprestIssue(user, parseId(params.id)), false) }),
  route({ method: 'POST', path: '/imprests', permissions: [P.EXPENSES_SUBMIT], body: ImprestBody, handler: ({ s, user, body }) => s.imprest.create(user, body) }),
  route({ method: 'PATCH', path: '/imprests/:id', permissions: [P.EXPENSES_SUBMIT], body: ImprestBody, handler: ({ s, user, params, body }) => s.imprest.update(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/imprests/:id/submit', permissions: [P.EXPENSES_SUBMIT], handler: ({ s, user, params }) => s.imprest.submit(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/imprests/:id/cancel', permissions: [P.EXPENSES_SUBMIT], body: required, handler: ({ s, user, params, body }) => s.imprest.cancel(user, parseId(params.id), body.reason) }),
  route({ method: 'POST', path: '/imprests/:id/approve', permissions: [P.EXPENSES_APPROVE], body: comment, handler: ({ s, user, params, body }) => s.imprest.approve(user, parseId(params.id), body.comment) }),
  route({ method: 'POST', path: '/imprests/:id/reject', permissions: [P.EXPENSES_APPROVE], body: required, handler: ({ s, user, params, body }) => s.imprest.reject(user, parseId(params.id), body.reason) }),
  route({
    method: 'POST',
    path: '/imprests/:id/issue',
    permissions: [P.EXPENSES_PAY],
    body: z.object({ date: zDate, bankAccountId: zId, reference: z.string().trim().max(100).optional() }),
    handler: ({ s, user, params, body }) => s.imprest.issue(user, parseId(params.id), body),
  }),
  route({ method: 'POST', path: '/imprests/:id/surrender', permissions: [P.EXPENSES_SUBMIT], body: SurrenderBody, handler: ({ s, user, params, body }) => s.imprest.submitSurrender(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/imprests/:id/surrender/approve', permissions: [P.EXPENSES_APPROVE], body: comment, handler: ({ s, user, params, body }) => s.imprest.approveSurrender(user, parseId(params.id), body.comment) }),
  route({ method: 'POST', path: '/imprests/:id/surrender/reject', permissions: [P.EXPENSES_APPROVE], body: required, handler: ({ s, user, params, body }) => s.imprest.rejectSurrender(user, parseId(params.id), body.reason) }),
  route({
    method: 'POST',
    path: '/imprests/:id/pay-balance',
    permissions: [P.EXPENSES_PAY],
    body: z.object({ date: zDate, bankAccountId: zId }),
    handler: ({ s, user, params, body }) => s.imprest.payBalance(user, parseId(params.id), body),
  }),
  route({
    method: 'POST',
    path: '/imprests/:id/recover',
    permissions: [P.EXPENSES_PAY],
    body: z.object({ date: zDate, fromPeriod: z.string().trim().regex(/^\d{4}-\d{2}$/).optional(), installment: zDecimal.nullable().optional() }),
    handler: ({ s, user, params, body }) => s.imprest.recover(user, parseId(params.id), body),
  }),
];

// Petty cash: limits per category, online requests, approval, payment from the box, the petty cash book.
const OptionalMoney = zDecimal.refine((v) => v.gt(0), 'Must be more than zero').nullable();
const pettyCash = [
  route({ method: 'GET', path: '/petty-cash/boxes', permissions: [P.EXPENSES_SUBMIT], handler: ({ s, user }) => s.pettyCash.boxes(user) }),
  route({ method: 'GET', path: '/petty-cash/boxes/:id/limits', permissions: [P.EXPENSES_SUBMIT], handler: ({ s, user, params }) => s.pettyCash.limits(user, parseId(params.id)) }),
  route({
    method: 'PATCH',
    path: '/petty-cash/boxes/:id/limits',
    permissions: [P.EXPENSES_PAY],
    body: z.object({ float: OptionalMoney, categories: z.array(z.object({ categoryId: zId, perVoucher: OptionalMoney, perMonth: OptionalMoney })).max(100) }),
    handler: ({ s, user, params, body }) => s.pettyCash.saveLimits(user, parseId(params.id), body),
  }),
  route({ method: 'GET', path: '/petty-cash/boxes/:id/book', permissions: [P.EXPENSES_PAY], handler: ({ s, user, params }) => s.pettyCash.book(user, parseId(params.id)) }),
  route({
    method: 'GET',
    path: '/petty-cash',
    permissions: [P.EXPENSES_SUBMIT],
    query: z.object({ status: z.string().max(20).optional(), mine: z.enum(['true', 'false']).optional(), bankAccountId: zId.optional() }),
    handler: ({ s, user, query }) => s.pettyCash.list(user, { ...query, mine: query.mine === 'true' }),
  }),
  route({
    method: 'POST',
    path: '/petty-cash',
    permissions: [P.EXPENSES_SUBMIT],
    body: z.object({ bankAccountId: zId, categoryId: zId, amount: zDecimal, purpose: z.string().trim().min(3).max(500), payee: z.string().trim().max(200).optional(), departmentId: zId.nullable().optional() }),
    handler: ({ s, user, body }) => s.pettyCash.request(user, body),
  }),
  route({ method: 'POST', path: '/petty-cash/:id/approve', permissions: [P.EXPENSES_APPROVE], handler: ({ s, user, params }) => s.pettyCash.approve(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/petty-cash/:id/reject', permissions: [P.EXPENSES_APPROVE], body: required, handler: ({ s, user, params, body }) => s.pettyCash.reject(user, parseId(params.id), body.reason) }),
  route({ method: 'POST', path: '/petty-cash/:id/cancel', permissions: [P.EXPENSES_SUBMIT], handler: ({ s, user, params }) => s.pettyCash.cancel(user, parseId(params.id)) }),
  route({ method: 'POST', path: '/petty-cash/:id/pay', permissions: [P.EXPENSES_PAY], body: z.object({ date: zDate, receiptReference: z.string().trim().max(100).optional() }), handler: ({ s, user, params, body }) => s.pettyCash.pay(user, parseId(params.id), body) }),
];

// Sponsorships and donations register.
const sponsorships = [
  route({ method: 'GET', path: '/sponsorships', permissions: [P.EXPENSES_SUBMIT], query: z.object({ status: z.string().max(20).optional(), year: z.coerce.number().int().min(2000).max(2100).optional() }), handler: ({ s, user, query }) => s.sponsorships.list(user, query) }),
  route({ method: 'GET', path: '/sponsorships/report', permissions: [P.EXPENSES_APPROVE], query: z.object({ year: z.coerce.number().int().min(2000).max(2100) }), handler: ({ s, user, query }) => s.sponsorships.report(user, query.year) }),
  route({
    method: 'POST',
    path: '/sponsorships',
    permissions: [P.EXPENSES_SUBMIT],
    body: z.object({
      entityId: zId,
      kind: z.enum(['SPONSORSHIP', 'DONATION', 'CSR', 'BURSARY']),
      beneficiary: z.string().trim().min(2).max(200),
      beneficiaryContact: z.string().trim().max(200).optional(),
      category: z.enum(['COMMUNITY', 'EDUCATION', 'HEALTH', 'SPORTS', 'ENVIRONMENT', 'EVENT', 'RELIEF', 'OTHER']).default('COMMUNITY'),
      purpose: z.string().trim().min(3).max(2000),
      eventDate: zDate.nullable().optional(),
      amount: zDecimal,
      inKind: z.string().trim().max(1000).optional(),
      inKindValue: zDecimal.nullable().optional(),
      benefits: z.string().trim().max(1000).optional(),
    }),
    handler: ({ s, user, body }) => s.sponsorships.create(user, body),
  }),
  route({ method: 'POST', path: '/sponsorships/:id/decide', permissions: [P.EXPENSES_APPROVE], body: z.object({ approve: z.boolean(), reason: z.string().trim().max(500).optional() }), handler: ({ s, user, params, body }) => s.sponsorships.decide(user, parseId(params.id), body) }),
  route({ method: 'POST', path: '/sponsorships/:id/paid', permissions: [P.EXPENSES_PAY], body: z.object({ paymentId: zId }), handler: ({ s, user, params, body }) => s.sponsorships.markPaid(user, parseId(params.id), body.paymentId) }),
  route({ method: 'POST', path: '/sponsorships/:id/acknowledge', permissions: [P.EXPENSES_SUBMIT], body: z.object({ text: z.string().trim().min(3).max(2000) }), handler: ({ s, user, params, body }) => s.sponsorships.acknowledge(user, parseId(params.id), body.text) }),
  route({ method: 'POST', path: '/sponsorships/:id/cancel', permissions: [P.EXPENSES_APPROVE], handler: ({ s, user, params }) => s.sponsorships.cancel(user, parseId(params.id)) }),
];

export const operationsRoutes = [...inventory, ...storeRequisitions, ...assets, ...expenses, ...imprest, ...pettyCash, ...sponsorships, ...budgets, ...budgetPlanning];
