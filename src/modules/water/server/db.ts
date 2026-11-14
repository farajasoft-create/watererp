import { ClientSession, Connection, Types } from 'mongoose';
import { Db, defineModel } from '@/platform/db';
import * as S from './schemas';
import * as SV from './service-schemas';
import * as OP from './ops-schemas';
import { telemetryPointSchema, telemetrySampleSchema } from './ops/telemetry.service';

/** The water module's collections, all prefixed water_. */
export function waterModels(conn: Connection) {
  return {
    waterSettings: defineModel(conn, 'WaterSettings', S.waterSettingsSchema, 'water_settings'),
    zones: defineModel(conn, 'WaterZone', S.zoneSchema, 'water_zones'),
    tariffs: defineModel(conn, 'WaterTariff', S.tariffSchema, 'water_tariffs'),
    customers: defineModel(conn, 'WaterCustomer', S.customerSchema, 'water_customers'),
    meters: defineModel(conn, 'WaterMeter', S.meterSchema, 'water_meters'),
    cycles: defineModel(conn, 'WaterReadingCycle', S.cycleSchema, 'water_reading_cycles'),
    readings: defineModel(conn, 'WaterReading', S.readingSchema, 'water_readings'),
    billRuns: defineModel(conn, 'WaterBillRun', S.billRunSchema, 'water_bill_runs'),
    bills: defineModel(conn, 'WaterBill', S.billSchema, 'water_bills'),
    payments: defineModel(conn, 'WaterPayment', S.paymentSchema, 'water_payments'),
    ledger: defineModel(conn, 'WaterLedgerEntry', S.ledgerEntrySchema, 'water_statement_lines'),
    adjustments: defineModel(conn, 'WaterAdjustment', S.adjustmentSchema, 'water_adjustments'),
    disconnections: defineModel(conn, 'WaterDisconnection', S.disconnectionSchema, 'water_disconnections'),
    tickets: defineModel(conn, 'WaterTicket', SV.ticketSchema, 'water_tickets'),
    paymentPlans: defineModel(conn, 'WaterPaymentPlan', SV.paymentPlanSchema, 'water_payment_plans'),
    debtCases: defineModel(conn, 'WaterDebtCase', SV.debtCaseSchema, 'water_debt_cases'),
    notices: defineModel(conn, 'WaterNotice', SV.noticeSchema, 'water_notices'),
    portalCodes: defineModel(conn, 'WaterPortalCode', SV.portalCodeSchema, 'water_portal_codes'),
    facilities: defineModel(conn, 'WaterFacility', OP.facilitySchema, 'water_facilities'),
    productionLogs: defineModel(conn, 'WaterProductionLog', OP.productionLogSchema, 'water_production_logs'),
    telemetryPoints: defineModel(conn, 'WaterTelemetryPoint', telemetryPointSchema, 'water_telemetry_points'),
    telemetrySamples: defineModel(conn, 'WaterTelemetrySample', telemetrySampleSchema, 'water_telemetry_samples'),
    chemicals: defineModel(conn, 'WaterChemical', OP.chemicalSchema, 'water_chemicals'),
    chemicalMovements: defineModel(conn, 'WaterChemicalMovement', OP.chemicalMovementSchema, 'water_chemical_movements'),
    qualityTests: defineModel(conn, 'WaterQualityTest', OP.qualityTestSchema, 'water_quality_tests'),
    reservoirLevels: defineModel(conn, 'WaterReservoirLevel', OP.reservoirLevelSchema, 'water_reservoir_levels'),
    supplySchedules: defineModel(conn, 'WaterSupplySchedule', OP.supplyScheduleSchema, 'water_supply_schedules'),
    networkFeatures: defineModel(conn, 'WaterNetworkFeature', OP.networkFeatureSchema, 'water_network_features'),
    workOrders: defineModel(conn, 'WaterWorkOrder', OP.workOrderSchema, 'water_work_orders'),
    maintenancePlans: defineModel(conn, 'WaterMaintenancePlan', OP.maintenancePlanSchema, 'water_maintenance_plans'),
    kioskSales: defineModel(conn, 'WaterKioskSale', OP.kioskSaleSchema, 'water_kiosk_sales'),
    bowserTrips: defineModel(conn, 'WaterBowserTrip', OP.bowserTripSchema, 'water_bowser_trips'),
  };
}

export type WaterModels = ReturnType<typeof waterModels>;
export type WaterDb = Db & WaterModels;

/** The organisation's water settings, created with defaults on first use. */
export async function waterSettings(db: WaterDb, organisationId: Types.ObjectId, session?: ClientSession) {
  const doc = await db.waterSettings.findOneAndUpdate({ organisationId }, { $setOnInsert: { organisationId } }, { upsert: true, new: true, session }).lean();
  return doc!;
}
