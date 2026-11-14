import { defineManifest } from '@/platform/manifest';

export const PERMISSIONS = {
  CUSTOMER_VIEW: 'water.customer.view',
  CUSTOMER_MANAGE: 'water.customer.manage',
  METER_MANAGE: 'water.meter.manage',
  TARIFF_MANAGE: 'water.tariff.manage',
  ZONE_MANAGE: 'water.zone.manage',
  READING_CAPTURE: 'water.reading.capture',
  READING_APPROVE: 'water.reading.approve',
  BILLING_RUN: 'water.billing.run',
  BILLING_APPROVE: 'water.billing.approve',
  PAYMENT_RECORD: 'water.payment.record',
  PAYMENT_ALLOCATE: 'water.payment.allocate',
  ADJUSTMENT_CREATE: 'water.adjustment.create',
  ADJUSTMENT_APPROVE: 'water.adjustment.approve',
  DISCONNECTION_MANAGE: 'water.disconnection.manage',
  NRW_VIEW: 'water.nrw.view',
  REPORTS_VIEW: 'water.reports.view',
  SETTINGS_MANAGE: 'water.settings.manage',
  SERVICE_VIEW: 'water.service.view',
  SERVICE_MANAGE: 'water.service.manage',
  DEBT_MANAGE: 'water.debt.manage',
  DEBT_APPROVE: 'water.debt.approve',
  NOTICE_SEND: 'water.notice.send',
  OPS_VIEW: 'water.ops.view',
  PRODUCTION_RECORD: 'water.production.record',
  QUALITY_RECORD: 'water.quality.record',
  NETWORK_MANAGE: 'water.network.manage',
  WORKS_MANAGE: 'water.works.manage',
  WORKS_FIELD: 'water.works.field',
  KIOSK_MANAGE: 'water.kiosk.manage',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

const P = PERMISSIONS;
const ALL = Object.values(P);

/** Approving one's own work is blocked in the services, not only by role. */
export const waterManifest = defineManifest({
  key: 'water',
  name: 'Water & Sanitation',
  description: 'Customers, meters, meter reading, tariff billing, M-Pesa collections, disconnections and NRW.',
  home: '/water',
  permissions: P,
  roles: {
    MANAGER: {
      label: 'Commercial manager',
      permissions: [P.CUSTOMER_VIEW, P.CUSTOMER_MANAGE, P.READING_APPROVE, P.BILLING_RUN, P.BILLING_APPROVE, P.PAYMENT_ALLOCATE, P.ADJUSTMENT_APPROVE, P.DISCONNECTION_MANAGE, P.NRW_VIEW, P.REPORTS_VIEW, P.SETTINGS_MANAGE, P.SERVICE_VIEW, P.SERVICE_MANAGE, P.DEBT_MANAGE, P.DEBT_APPROVE, P.NOTICE_SEND, P.OPS_VIEW, P.WORKS_MANAGE, P.KIOSK_MANAGE],
    },
    BILLING: {
      label: 'Billing officer',
      permissions: [P.CUSTOMER_VIEW, P.CUSTOMER_MANAGE, P.METER_MANAGE, P.READING_CAPTURE, P.READING_APPROVE, P.BILLING_RUN, P.ADJUSTMENT_CREATE, P.DISCONNECTION_MANAGE, P.REPORTS_VIEW, P.SERVICE_VIEW, P.DEBT_MANAGE],
    },
    CASHIER: { label: 'Cashier', permissions: [P.CUSTOMER_VIEW, P.PAYMENT_RECORD, P.PAYMENT_ALLOCATE, P.SERVICE_VIEW] },
    CUSTOMER_SERVICE: { label: 'Customer service / call centre', description: 'Logs and follows up complaints, sends notices.', permissions: [P.CUSTOMER_VIEW, P.SERVICE_VIEW, P.SERVICE_MANAGE, P.NOTICE_SEND] },
    CREDIT_CONTROL: { label: 'Credit control', description: 'Payment plans and debt cases.', permissions: [P.CUSTOMER_VIEW, P.DEBT_MANAGE, P.DISCONNECTION_MANAGE, P.REPORTS_VIEW, P.ADJUSTMENT_CREATE, P.SERVICE_VIEW] },
    TECHNICAL: {
      label: 'Technical / NRW',
      permissions: [P.CUSTOMER_VIEW, P.METER_MANAGE, P.ZONE_MANAGE, P.READING_CAPTURE, P.DISCONNECTION_MANAGE, P.NRW_VIEW, P.SERVICE_VIEW, P.SERVICE_MANAGE, P.OPS_VIEW, P.PRODUCTION_RECORD, P.QUALITY_RECORD, P.NETWORK_MANAGE, P.WORKS_MANAGE, P.WORKS_FIELD, P.KIOSK_MANAGE],
    },
    OPERATOR: { label: 'Plant operator', description: 'Production, dosing, reservoir levels and water-quality tests.', permissions: [P.OPS_VIEW, P.PRODUCTION_RECORD, P.QUALITY_RECORD, P.WORKS_FIELD] },
    FIELD_CREW: { label: 'Field crew (plumber, fitter)', description: 'Sees and completes the jobs assigned to them on the phone.', permissions: [P.OPS_VIEW, P.WORKS_FIELD] },
    GIS: { label: 'GIS officer', permissions: [P.CUSTOMER_VIEW, P.OPS_VIEW, P.NETWORK_MANAGE] },
    METER_READER: { label: 'Meter reader', description: 'Uses the field app; limit them to their zones.', permissions: [P.READING_CAPTURE] },
    VIEWER: { label: 'Viewer', permissions: [P.CUSTOMER_VIEW, P.NRW_VIEW, P.REPORTS_VIEW, P.SERVICE_VIEW] },
    FULL: { label: 'Full access', permissions: ALL },
  },
  scope: { label: 'Zones (meter readers see only these)', endpoint: '/water/zones' },
  nav: [
    { href: '/water', label: 'Dashboard', permission: P.REPORTS_VIEW },
    { href: '/water/customers', label: 'Customers', permission: P.CUSTOMER_VIEW },
    { href: '/water/meters', label: 'Meters', permission: P.CUSTOMER_VIEW },
    { href: '/water/readings', label: 'Meter readings', permission: P.CUSTOMER_VIEW },
    { href: '/water/billing', label: 'Billing', permission: P.CUSTOMER_VIEW },
    { href: '/water/payments', label: 'Payments', permission: P.CUSTOMER_VIEW },
    { href: '/water/adjustments', label: 'Adjustments', permission: P.CUSTOMER_VIEW },
    { href: '/water/disconnections', label: 'Disconnections', permission: P.CUSTOMER_VIEW },
    { href: '/water/debt', label: 'Debt & payment plans', permission: P.CUSTOMER_VIEW },
    { href: '/water/service', label: 'Customer service', permission: P.SERVICE_VIEW },
    { href: '/water/notices', label: 'Notices to customers', permission: P.SERVICE_VIEW },
    { href: '/water/nrw', label: 'NRW & water balance', permission: P.NRW_VIEW },
    { href: '/water/production', label: 'Production & quality', permission: P.OPS_VIEW },
    { href: '/water/telemetry', label: 'SCADA & telemetry', permission: P.OPS_VIEW },
    { href: '/water/works', label: 'Field jobs & maintenance', permission: P.OPS_VIEW },
    { href: '/water/map', label: 'Network map (GIS)', permission: P.OPS_VIEW },
    { href: '/water/kiosks', label: 'Kiosks & bowsers', permission: P.OPS_VIEW },
    { href: '/water/reports', label: 'Reports', permission: P.REPORTS_VIEW },
    { href: '/water/setup', label: 'Zones & tariffs', permission: P.CUSTOMER_VIEW },
    { href: '/water/settings', label: 'Water settings', permission: P.SETTINGS_MANAGE },
  ],
  links: [
    { href: '/water/field', label: 'Field reading app →', permission: P.READING_CAPTURE },
    { href: '/water/jobs', label: 'My field jobs →', permission: P.WORKS_FIELD },
  ],
});
