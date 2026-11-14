import { Money } from '@/components/ui';
import { PayLine } from './types';

/** A payslip's lines in three columns: pay, deductions and what the employer adds. */
export function PayLines({ lines }: { lines: PayLine[] }) {
  const groups: [string, PayLine['type'][]][] = [
    ['Pay', ['BASIC', 'EARNING', 'REIMBURSEMENT']],
    ['Deductions', ['STATUTORY', 'DEDUCTION']],
    ['Employer contributions', ['EMPLOYER']],
  ];
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {groups.map(([title, types]) => (
        <div key={title}>
          <div className="mb-1 text-xs font-semibold uppercase text-muted">{title}</div>
          {lines.filter((l) => types.includes(l.type)).map((l, i) => (
            <div key={`${l.code}-${i}`} className="flex justify-between border-b border-line py-1 text-sm">
              <span>{l.name}</span>
              <Money value={l.amount} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
