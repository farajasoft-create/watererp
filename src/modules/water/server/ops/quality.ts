import { dec, DecimalInput } from '@/platform/common/money';

export interface QualityResult {
  residualChlorine?: DecimalInput;
  turbidity?: DecimalInput;
  ph?: DecimalInput;
  eColi?: DecimalInput;
  totalColiforms?: DecimalInput;
  colour?: DecimalInput;
  conductivity?: DecimalInput;
}

type Point = 'RAW' | 'TREATED' | 'RESERVOIR' | 'NETWORK' | 'CONSUMER_TAP' | 'KIOSK';

const given = (v: DecimalInput | undefined) => v !== undefined && v !== null && v !== '';

/**
 * Checks a sample against KS EAS 12:2014 and the WASREB drinking water guidelines: free residual
 * chlorine 0.2–0.5 mg/L in supply (treated water at the works may carry up to 1.0 mg/L to last the
 * network), turbidity at most 5 NTU, pH 6.5–8.5, no E. coli or coliforms in 100 mL, colour at most
 * 15 TCU, conductivity at most 1,500 µS/cm. Raw water is recorded but not judged.
 */
export function assessQuality(point: Point, r: QualityResult): { passed: boolean; failures: string[] } {
  if (point === 'RAW') return { passed: true, failures: [] };
  const failures: string[] = [];
  if (given(r.residualChlorine)) {
    const v = dec(r.residualChlorine);
    const max = point === 'TREATED' ? 1 : 0.5;
    if (v.lt(0.2)) failures.push(`Residual chlorine ${v.toFixed()} mg/L is below 0.2`);
    else if (v.gt(max)) failures.push(`Residual chlorine ${v.toFixed()} mg/L is above ${max}`);
  }
  if (given(r.turbidity) && dec(r.turbidity).gt(5)) failures.push(`Turbidity ${dec(r.turbidity).toFixed()} NTU is above 5`);
  if (given(r.ph) && (dec(r.ph).lt(6.5) || dec(r.ph).gt(8.5))) failures.push(`pH ${dec(r.ph).toFixed()} is outside 6.5–8.5`);
  if (given(r.eColi) && dec(r.eColi).gt(0)) failures.push(`E. coli ${dec(r.eColi).toFixed()} per 100 mL (must be 0)`);
  if (given(r.totalColiforms) && dec(r.totalColiforms).gt(0)) failures.push(`Total coliforms ${dec(r.totalColiforms).toFixed()} per 100 mL (must be 0)`);
  if (given(r.colour) && dec(r.colour).gt(15)) failures.push(`Colour ${dec(r.colour).toFixed()} TCU is above 15`);
  if (given(r.conductivity) && dec(r.conductivity).gt(1500)) failures.push(`Conductivity ${dec(r.conductivity).toFixed()} µS/cm is above 1,500`);
  return { passed: failures.length === 0, failures };
}

/** Hours of supply a day from a zone's timetable rows (HH:MM–HH:MM on given weekdays), averaged over the week. */
export function hoursPerDay(rows: { days: number[]; from: string; to: string }[]): number {
  if (!rows.length) return 24;
  const minutes = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + (m || 0);
  };
  let weekly = 0;
  for (const r of rows) {
    let span = minutes(r.to) - minutes(r.from);
    if (span <= 0) span += 24 * 60;
    weekly += (span / 60) * new Set(r.days).size;
  }
  return Math.min(24, Math.round((weekly / 7) * 10) / 10);
}
