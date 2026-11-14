import { createHash, randomInt } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { jwtVerify, SignJWT } from 'jose';
import { Types } from 'mongoose';
import { openPortal } from '@/platform/common/branding';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, UnauthorizedException } from '@/platform/common/errors';
import { EmailService } from '@/platform/services/email.service';
import { SmsService } from '@/platform/services/sms.service';
import { HrDb as Db } from '../db';
import { QUALIFICATION_LEVELS } from '../schemas';

type Id = Types.ObjectId;
type Level = (typeof QUALIFICATION_LEVELS)[number];
type Purpose = 'REGISTER' | 'LOGIN' | 'RESET';

export const APPLICANT_COOKIE = 'fs_applicant';
const SESSION_SECONDS = 2 * 60 * 60;
const CODE_MINUTES = 10;
const MAX_ATTEMPTS = 5;

const secret = () => {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32) throw new Error('JWT_SECRET must be set to at least 32 characters');
  return new TextEncoder().encode(value);
};
let dummy: string | undefined;
/** Compared against when there is no account, so a miss takes as long as a hit. */
const dummyHash = () => (dummy ??= bcrypt.hashSync('not-a-password', 10));
const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');

export interface ApplicantProfile {
  gender?: 'MALE' | 'FEMALE' | null;
  dateOfBirth?: Date | null;
  county?: string;
  disability?: boolean;
  highestLevel?: Level | null;
  experienceYears?: number;
  qualifications?: { level: string; title: string; institution?: string; year?: number | null }[];
  experience?: { employer: string; position: string; from?: Date | null; to?: Date | null; duties?: string }[];
  professional?: { body: string; membershipNo?: string; year?: number | null }[];
  referees?: { name: string; position?: string; phone?: string; email?: string }[];
  summary?: string;
}

/** Reads the applicant session from the request (its own cookie, never a staff session). */
export function applicantToken(req: Request): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === APPLICANT_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/**
 * Applicant accounts on the public jobs page. Registration and every sign-in are confirmed with a
 * one-time code sent by email and SMS (two-step); a forgotten password is reset with a code; the
 * applicant keeps one profile (education, experience, professional bodies, referees), applies with it
 * and follows each application by its tracking number, and can deactivate the account. Each of these
 * steps is confirmed to the applicant by email and SMS.
 */
export class ApplicantsService {
  constructor(
    private readonly db: Db,
    private readonly email: EmailService,
    private readonly sms: SmsService,
  ) {}

  private async org(code: string) {
    const org = await this.db.organisations.findOne({ code: code.toUpperCase(), modules: 'hr' }, { name: 1 }).lean();
    if (!org) throw new NotFoundException('Organisation not found');
    await openPortal(this.db.connection, org._id, 'jobs');
    return org;
  }

  /** An email and a text message to the applicant; both go out now. */
  async tell(organisationId: Id, a: { email: string; phone: string }, subject: string, text: string, purpose: string, sourceId?: Id) {
    await this.email.queue(organisationId, a.email, subject, text, purpose, sourceId);
    await this.sms.queue(organisationId, a.phone, `${subject}. ${text}`.slice(0, 459), purpose, sourceId);
    await Promise.all([this.email.deliverDue(organisationId), this.sms.deliverDue(organisationId)]);
  }

  private async sendCode(organisationId: Id, a: { _id: Id; email: string; phone: string }, purpose: Purpose, orgName: string) {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.db.applicants.updateOne({ _id: a._id }, { otp: { codeHash: hashCode(code), purpose, expiresAt: new Date(Date.now() + CODE_MINUTES * 60_000), attempts: 0 } });
    const why = purpose === 'REGISTER' ? 'confirm your registration' : purpose === 'LOGIN' ? 'finish signing in' : 'reset your password';
    await this.tell(organisationId, a, `${orgName} jobs: your code is ${code}`, `Use ${code} to ${why}. It expires in ${CODE_MINUTES} minutes. If this was not you, ignore this message.`, `hr:applicant:${purpose.toLowerCase()}`, a._id);
    // Tests read the code from the outbox; it is never returned to the caller.
    return { sentTo: { email: a.email.replace(/^(.).*(@.*)$/, '$1***$2'), phone: `***${a.phone.slice(-3)}` }, expiresInMinutes: CODE_MINUTES };
  }

  private async checkCode(applicantId: Id, purpose: Purpose, code: string) {
    const a = await this.db.applicants.findById(applicantId).lean();
    if (!a || a.otp?.purpose !== purpose || !a.otp.codeHash) throw new BadRequestException('Ask for a new code');
    if ((a.otp.attempts ?? 0) >= MAX_ATTEMPTS) throw new ForbiddenException('Too many wrong codes; ask for a new one');
    if (!a.otp.expiresAt || a.otp.expiresAt < new Date()) throw new BadRequestException('The code has expired; ask for a new one');
    if (a.otp.codeHash !== hashCode(code.trim())) {
      await this.db.applicants.updateOne({ _id: a._id }, { $inc: { 'otp.attempts': 1 } });
      throw new BadRequestException('That code is not right');
    }
    await this.db.applicants.updateOne({ _id: a._id }, { otp: { codeHash: null, purpose: null, expiresAt: null, attempts: 0 } });
    return a;
  }

  private async session(a: { _id: Id; organisationId: Id; tokenVersion?: number | null }) {
    return new SignJWT({ org: a.organisationId.toHexString(), tv: a.tokenVersion ?? 0 })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(a._id.toHexString())
      .setAudience('applicant')
      .setIssuedAt()
      .setExpirationTime(`${SESSION_SECONDS}s`)
      .sign(secret());
  }

  /** The signed-in applicant, from the applicant cookie. */
  async current(req: Request, code: string) {
    const token = applicantToken(req);
    if (!token) throw new UnauthorizedException('Sign in to your applicant account');
    let payload: { sub?: string; org?: unknown; tv?: unknown };
    try {
      ({ payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'], audience: 'applicant' }));
    } catch {
      throw new UnauthorizedException('Your session has expired; sign in again');
    }
    const org = await this.org(code);
    const a = payload.sub && Types.ObjectId.isValid(payload.sub) ? await this.db.applicants.findById(payload.sub).lean() : null;
    if (!a || !a.organisationId.equals(org._id) || payload.org !== org._id.toHexString() || a.tokenVersion !== payload.tv || a.status !== 'ACTIVE' || !a.verifiedAt) throw new UnauthorizedException('Sign in again');
    return a;
  }

  async register(code: string, input: { name: string; email: string; phone: string; nationalId: string; password: string }) {
    const org = await this.org(code);
    const email = input.email.toLowerCase();
    const existing = await this.db.applicants.findOne({ organisationId: org._id, $or: [{ email }, { nationalId: input.nationalId }] }).lean();
    if (existing?.verifiedAt && existing.status === 'ACTIVE') throw new ConflictException('There is already an account with that email or ID number; sign in instead');
    const passwordHash = await bcrypt.hash(input.password, 10);
    let a;
    if (existing) {
      // An unfinished or deactivated account is started again.
      await this.db.applicants.updateOne({ _id: existing._id }, { name: input.name, email, phone: input.phone, nationalId: input.nationalId, passwordHash, verifiedAt: null, status: 'ACTIVE', deactivatedAt: null, $inc: { tokenVersion: 1 } });
      a = (await this.db.applicants.findById(existing._id).lean())!;
    } else {
      [a] = await this.db.applicants.create([{ organisationId: org._id, name: input.name, email, phone: input.phone, nationalId: input.nationalId, passwordHash }]);
    }
    return { applicantId: a._id, ...(await this.sendCode(org._id, a, 'REGISTER', org.name)) };
  }

  /** The registration code: the account becomes active and the applicant is signed in. */
  async verifyRegistration(code: string, input: { applicantId: Id; code: string }) {
    const org = await this.org(code);
    const a = await this.checkCode(input.applicantId, 'REGISTER', input.code);
    if (!a.organisationId.equals(org._id)) throw new NotFoundException('Account not found');
    await this.db.applicants.updateOne({ _id: a._id }, { verifiedAt: new Date() });
    await this.tell(org._id, a, `${org.name}: your applicant account is ready`, `Welcome, ${a.name}. Complete your profile, then apply for open vacancies.`, 'hr:applicant:registered', a._id);
    return { token: await this.session(a), name: a.name };
  }

  /** Step one of signing in: the password; a code then goes to the applicant's email and phone. */
  async login(code: string, input: { email: string; password: string }) {
    const org = await this.org(code);
    const a = await this.db.applicants.findOne({ organisationId: org._id, email: input.email.toLowerCase() }).lean();
    const ok = await bcrypt.compare(input.password, a?.passwordHash ?? dummyHash());
    if (!a || !ok || a.status !== 'ACTIVE' || !a.verifiedAt) throw new UnauthorizedException('Email or password is not right');
    return { applicantId: a._id, ...(await this.sendCode(org._id, a, 'LOGIN', org.name)) };
  }

  async verifyLogin(code: string, input: { applicantId: Id; code: string }) {
    const org = await this.org(code);
    const a = await this.checkCode(input.applicantId, 'LOGIN', input.code);
    if (!a.organisationId.equals(org._id) || a.status !== 'ACTIVE') throw new UnauthorizedException('Sign in again');
    return { token: await this.session(a), name: a.name };
  }

  /** Always answers the same, so the form does not reveal who has an account. */
  async forgot(code: string, email: string) {
    const org = await this.org(code);
    const a = await this.db.applicants.findOne({ organisationId: org._id, email: email.toLowerCase(), status: 'ACTIVE', verifiedAt: { $ne: null } }).lean();
    if (a) await this.sendCode(org._id, a, 'RESET', org.name);
    return { applicantId: a?._id ?? new Types.ObjectId(), message: 'If the email has an account, a code has been sent to it and to the phone on the account.' };
  }

  async reset(code: string, input: { applicantId: Id; code: string; password: string }) {
    const org = await this.org(code);
    const a = await this.checkCode(input.applicantId, 'RESET', input.code);
    if (!a.organisationId.equals(org._id)) throw new NotFoundException('Account not found');
    await this.db.applicants.updateOne({ _id: a._id }, { passwordHash: await bcrypt.hash(input.password, 10), $inc: { tokenVersion: 1 } });
    await this.tell(org._id, a, `${org.name}: your password was changed`, 'Your applicant account password was reset. If this was not you, reset it again at once and tell HR.', 'hr:applicant:reset', a._id);
    return { ok: true };
  }

  async me(req: Request, code: string) {
    const a = await this.current(req, code);
    const applications = await this.db.applications.find({ organisationId: a.organisationId, applicantId: a._id }, { reference: 1, vacancyId: 1, status: 1, interviewAt: 1, interviewVenue: 1, createdAt: 1, reportBy: 1 }).sort({ createdAt: -1 }).lean();
    const vacancies = await this.db.vacancies.find({ _id: { $in: applications.map((x) => x.vacancyId) } }, { title: 1, number: 1 }).lean();
    return {
      name: a.name,
      email: a.email,
      phone: a.phone,
      nationalId: a.nationalId,
      profile: a.profile,
      applications: applications.map((x) => ({ ...x, vacancy: vacancies.find((v) => v._id.equals(x.vacancyId))?.title ?? '', status: x.status === 'NOT_SHORTLISTED' ? 'REGRET' : x.status })),
    };
  }

  /** Saves any section of the profile; details given replace that section. */
  async saveProfile(req: Request, code: string, input: { name?: string; phone?: string; profile: ApplicantProfile }) {
    const a = await this.current(req, code);
    const set: Record<string, unknown> = Object.fromEntries(Object.entries(input.profile).filter(([, v]) => v !== undefined).map(([k, v]) => [`profile.${k}`, v]));
    if (input.name) set.name = input.name;
    if (input.phone) set.phone = input.phone;
    await this.db.applicants.updateOne({ _id: a._id }, set);
    return this.me(req, code);
  }

  async deactivate(req: Request, code: string, password: string) {
    const a = await this.current(req, code);
    if (!(await bcrypt.compare(password, a.passwordHash))) throw new UnauthorizedException('The password is not right');
    await this.db.applicants.updateOne({ _id: a._id }, { status: 'DEACTIVATED', deactivatedAt: new Date(), $inc: { tokenVersion: 1 } });
    await this.tell(a.organisationId, a, 'Your applicant account was deactivated', 'Your account is closed. Applications already made stay with HR for the recruitment record. You can register again at any time.', 'hr:applicant:deactivated', a._id);
    return { ok: true };
  }
}
