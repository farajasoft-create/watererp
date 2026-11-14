import { createCipheriv, randomBytes } from 'node:crypto';
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { decryptor, departmentCode, itemCode, mapEmployee, mapPayslip, parsePeriod, payrunStatus } from './farajasofterp-map';

const KEY = 'a'.repeat(64);
function encrypt(text: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(KEY, 'hex'), iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `enc:${iv.toString('hex')}:${c.getAuthTag().toString('hex')}:${data.toString('hex')}`;
}

describe('farajasofterp import mapping', () => {
  it('reads farajasofterp periods and statuses', () => {
    expect(parsePeriod('October 2026')).toBe('2026-10');
    expect(parsePeriod('Sept 2025')).toBe('2025-09');
    expect(parsePeriod('2026-01')).toBe('2026-01');
    expect(parsePeriod('Q3 2026')).toBeNull();
    expect(payrunStatus({ status: 'Ready' })).toBe('APPROVED');
    expect(payrunStatus({ status: 'Complete' })).toBe('PAID');
    expect(payrunStatus({ status: 'Draft' })).toBeNull();
  });

  it('decrypts encrypted fields and refuses without the key', () => {
    expect(decryptor(KEY)(encrypt('12345678'))).toBe('12345678');
    expect(decryptor(KEY)('plain')).toBe('plain');
    expect(() => decryptor()(encrypt('x'))).toThrow(/SOURCE_FIELD_ENCRYPTION_KEY/);
  });

  it('maps an employee, statutory numbers from custom fields and allowances from the salary', () => {
    const e = mapEmployee(
      {
        _id: new Types.ObjectId(),
        employeeId: 'FS-014',
        firstName: 'Faith',
        lastName: 'Jeptoo',
        gender: 'female',
        status: 'active',
        phone: '0712 345 678',
        nationalId: encrypt('23456789'),
        dateOfJoining: '2022-03-01',
        contractType: 'Fixed-term contract',
        department: 'Finance',
        position: 'Accountant',
        salary: { basicSalary: 80000, houseAllowance: 12000, transportAllowance: 3000, grossSalary: 95000 },
        customFields: { kraPin: 'a123456789z', nssfNumber: '200123', nhifNumber: 'CR9' },
        bankInfo: { bankCode: 'KCBL', accountNumber: encrypt('1100223344'), branchCode: '01001' },
        preferredPaymentMethod: 'BANK',
        password: '$2a$10$abcdefghijklmnopqrstuv',
      },
      decryptor(KEY),
    );
    expect(e).toMatchObject({ employeeNo: 'FS-014', gender: 'FEMALE', phone: '254712345678', nationalId: '23456789', kraPin: 'A123456789Z', nssfNo: '200123', shaNo: 'CR9', employmentType: 'CONTRACT', status: 'ACTIVE' });
    expect(e.basicSalary.toFixed(2)).toBe('80000.00');
    expect(e.bank.accountNo).toBe('1100223344');
    expect(e.allowances.map((a) => [a.code, a.name, a.amount.toFixed()])).toEqual([
      ['HOUSE_ALW', 'House allowance', '12000'],
      ['TRANS_ALW', 'Transport allowance', '3000'],
    ]);
    expect(e.passwordHash).toMatch(/^\$2a\$/);
    expect(e.warnings).toEqual([]);
  });

  it('warns about what cannot come across cleanly', () => {
    const e = mapEmployee({ _id: new Types.ObjectId(), employeeId: 'C-1', firstName: 'Casual', lastName: 'Worker', phone: '12345', customFields: { kraPin: 'bad' }, paySettings: { payType: 'daily_rate', rate: 800 } }, decryptor());
    expect(e.warnings.join(' ')).toMatch(/KRA PIN "bad"/);
    expect(e.warnings.join(' ')).toMatch(/phone/);
    expect([e.payType, e.rate.toFixed(2)]).toEqual(['DAILY', '800.00']);
    expect(e.warnings.join(' ')).toMatch(/joining date/);
  });

  it('turns a pay run entry into a payslip as it was paid', () => {
    const p = mapPayslip({
      id: 'abc',
      employeeId: 'FS-014',
      firstName: 'Faith',
      'Basic Salary': 80000,
      'House Allowance': 12000,
      Overtime: 0,
      'Sacco Deduction': -2500,
      PAYETax: -18535.08,
      PAYETaxPercentage: '20%',
      NSSFTax: -5520,
      SHIFTax: -2530,
      AHLTax: -1380,
      'employer_NSSF Employer': 5520,
      'employer_AHL Employer': 1380,
      nssfTierIEmployee: 540,
      nssfTierIIEmployee: 4980,
      fixedSalary: 92000,
      totalEarnings: 0,
      totalDeductions: 30465.08,
      netSalary: 61534.92,
    });
    expect(p.gross.toFixed(2)).toBe('92000.00');
    expect([p.paye.toFixed(2), p.nssfEmployee.toFixed(2), p.shif.toFixed(2), p.ahlEmployee.toFixed(2)]).toEqual(['18535.08', '5520.00', '2530.00', '1380.00']);
    expect(p.otherDeductions.toFixed(2)).toBe('2500.00');
    expect(p.netPay.toFixed(2)).toBe('61534.92');
    expect([p.nssfTier1.toFixed(), p.nssfTier2.toFixed(), p.nssfEmployer.toFixed(), p.ahlEmployer.toFixed()]).toEqual(['540', '4980', '5520', '1380']);
    expect(p.taxablePay.toFixed(2)).toBe('82570.00');
    expect(p.taxCharged.toFixed(2)).toBe('20935.08');
    expect(p.lines.map((l) => `${l.type}:${l.code}`)).toEqual(['BASIC:BASIC', 'EARNING:HOUSE_ALW', 'DEDUCTION:SACCO_DED', 'STATUTORY:PAYE', 'STATUTORY:NSSF', 'STATUTORY:SHIF', 'STATUTORY:AHL', 'EMPLOYER:NSSF_ER', 'EMPLOYER:AHL_ER']);
  });

  it('makes short, unique codes', () => {
    const taken = new Set<string>(['HR']);
    expect(departmentCode('Human Resources', taken)).toBe('HR2');
    expect(departmentCode('Finance & Administration', taken)).toBe('FA');
    expect(departmentCode('Technical', taken)).toBe('TECH');
    expect(itemCode('medical_allowance')).toBe('MED_ALW');
  });
});
