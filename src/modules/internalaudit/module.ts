import { defineModule } from '@/platform/module';
import { internalauditManifest } from './manifest';
import { buildInternalauditServices, InternalauditServices } from './server/container';
import { iaSettings, internalauditModels, InternalauditModels } from './server/db';
import { internalauditRoutes } from './server/routes';

/** Starter audit programmes an organisation can edit. */
const PROGRAMMES = [
  {
    name: 'Revenue collection and billing',
    area: 'Commercial',
    objective: 'Bills are complete and accurate, collections are banked in full and promptly, and arrears are followed up.',
    procedures: [
      { ref: 'RC-01', title: 'Meter readings to bills', steps: 'Select readings for the month; agree each to the bill, tariff and customer category; investigate estimates over two months.' },
      { ref: 'RC-02', title: 'Collections to bank', steps: 'Agree daily cash and M-Pesa collections to bank statements; check banking within one working day.' },
      { ref: 'RC-03', title: 'Adjustments and write-offs', steps: 'Review bill adjustments and write-offs for approval by someone other than the preparer and supporting documents.' },
      { ref: 'RC-04', title: 'Debt follow-up', steps: 'Review the ageing; test disconnection notices and payment plans for accounts over 90 days.' },
    ],
  },
  {
    name: 'Procurement (PPADA 2015)',
    area: 'Supply chain',
    objective: 'Purchases follow the procurement plan and the Public Procurement and Asset Disposal Act, and goods are received as ordered.',
    procedures: [
      { ref: 'PR-01', title: 'Plan and budget', steps: 'Agree purchases to the approved procurement plan and budget lines.' },
      { ref: 'PR-02', title: 'Method and thresholds', steps: 'Check the procurement method against the value thresholds; test for split orders.' },
      { ref: 'PR-03', title: 'Evaluation and award', steps: 'Review evaluation committee appointment, scoring and the award against the recommendation.' },
      { ref: 'PR-04', title: 'Receipt and inspection', steps: 'Agree LPO to GRN, inspection certificate and invoice (three-way match).' },
    ],
  },
];

export const internalauditModule = defineModule<InternalauditServices, InternalauditModels>({
  manifest: internalauditManifest,
  models: internalauditModels,
  services: ({ db, core }) => buildInternalauditServices(db, core),
  routes: internalauditRoutes,
  seed: async ({ services, organisationId }) => {
    await iaSettings(services.db, organisationId);
    if (!(await services.db.programmes.exists({ organisationId }))) await services.db.programmes.insertMany(PROGRAMMES.map((p) => ({ ...p, organisationId })));
  },
});
