# FarajaSoft

One system for the whole organisation: **one login, one database, one ledger connection, one SMS gateway**,
with each business system as a module. Water & Sanitation and HR & Payroll are installed; procurement, CRM,
finance and anything else plug in the same way.

```
src/
  platform/              shared by every module
    manifest.ts          the module contract (permissions, roles, menu) – browser-safe
    module.ts            the server half of a module (models, services, routes, start, seed)
    container.ts         builds core services, then every module on top of them
    api.ts               mounts core routes + each module under /api/v1/<key>
    auth.ts              sign-in; one role per module per user; administrators get everything
    ledger/              the one general ledger: posts to FarajaSoft Accounting, or to a module that keeps the books
    events.ts            modules tell each other what happened (water.payment.posted, …) without importing each other
    services/            users, organisation & module switches, audit trail, SMS outbox
  modules/
    manifests.ts         installed modules (browser)
    server.ts            installed modules (server)
    water/               manifest.ts, module.ts, server/ (schemas, services, routes, seed), ui/
    hr/                  the same shape: employees, payroll engine, leave, returns, self-service
  app/
    (app)/page.tsx       home: a card per module the user can use
    (app)/settings       organisation, modules on/off, users & roles, ledger, SMS
    (app)/water/…        the water pages (/water/…)
    (app)/hr/…           the HR pages (/hr/…); printable payslips and P9s under app/hr
```

## The rules every module follows

| | |
|---|---|
| **Key** | lowercase, e.g. `hr`. It is the URL (`/hr`), the API prefix (`/api/v1/hr`), the collection prefix (`hr_payslips`) and the permission prefix (`hr.payroll.run`). Checked at start-up and in the tests. |
| **Data** | its own collections in the shared database, every document carries `organisationId`. One MongoDB transaction can cover several modules. |
| **Users** | nobody logs in "to a module". A user has one role per module (set under Settings → Users & roles), optionally limited to some records (`scope`: zones, branches…). |
| **Switches** | an organisation turns modules on/off under Settings → Modules. A module that is off is hidden and its API refuses every call (M-Pesa callbacks included). |
| **Money** | modules never talk to accounting directly: they build a balanced journal and call `core.ledger.post(orgId, journal, idempotencyKey)`. Each module maps its own accounts in its settings. |
| **Other modules** | talk through `core.events` (`emit` after a change, `on('water.*', …)` to listen) – never by importing another module's services. |
| **Shared tools** | `core.audit`, `core.sms`, `db.next()` numbering, `db.transaction()`. |

## Adding a system

```bash
npm run module:new -- hr "HR & Payroll"
```

That creates `src/modules/hr` (manifest, models, services, routes, a sample collection) and a first page at
`/hr`, and registers it. Then: switch it on under Settings → Modules, give users a role, and replace the
sample with the real thing. Bringing an existing app in (e.g. farajasofterp's payroll) means moving its
schemas, services and pages into the module and swapping its own login, users and organisation for the
platform's – the rest of its code barely changes, since every FarajaSoft app is already Next.js + Mongoose.

When a finance module arrives, it calls `core.ledger.use(itsLedger)` in `start`, and every module's journals
go to it, in the same database, instead of over HTTP to FarajaSoft Accounting. No other module changes.

## Water & Sanitation module

| Area | What it does |
|---|---|
| Customers | Connection applications → approval → connection; KYC, categories, zones; legacy-balance migration; account statement |
| Meters | Stores, installation, replacement (final reading billed), faulty/testing, bulk & production meters per zone |
| Meter reading | Reading cycles; **offline field app** (`/water/field`, installable PWA) with photo, GPS and exception codes; automatic high/low/zero/negative/rollover checks; office review; estimates (no double billing when the next actual reading arrives) |
| Tariffs | WASREB increasing-block tariffs with a flat first band, meter rent, sewerage %, minimum charge; bill calculator |
| Billing | Billing runs → draft bills → approval by a second person → numbered bills, statement lines, SMS; penalties; printable bill; billing register CSV |
| Payments | M-Pesa paybill (Daraja C2B, idempotent, fuzzy account matching), cash and bank receipts, unmatched-payment allocation, reversals |
| Adjustments | Credits / debit notes with maker-checker approval |
| Disconnections | Arrears-based list, SMS notices, disconnect, reconnect with fee |
| NRW | IWA/WASREB water balance per zone/DMA from bulk meters vs billed volume |
| Reports | Dashboard with WASREB KPIs, debt ageing |

Events it raises: `water.bill-run.approved`, `water.payment.posted`, `water.payment.reversed`, `water.adjustment.approved`.

## HR & Payroll module

Brought over from farajasofterp, rebuilt on the platform (exact decimal maths, one login, the shared ledger).

| Area | What it does |
|---|---|
| Employees | Records with KRA PIN, NSSF and SHA numbers, departments, contracts and probation; leaving, suspension, reinstatement; pay details visible only with salary rights. Monthly salary, or a daily or hourly rate for casual and part-time staff |
| Pay items | Recurring or one-off allowances and deductions; reimbursements (not taxed); pension (tax relief up to the cap); loans that stop when repaid |
| Payroll engine | PAYE bands and personal relief, NSSF tiers, SHIF (2.75%, min 300), housing levy 1.5% + 1.5%, NITA; NSSF, SHIF and AHL deducted before PAYE (Tax Laws (Amendment) Act 2024). Rates are dated sets editable in HR settings – seeded with February 2025 and February 2026 (NSSF 9,000 / 108,000) |
| Payroll | Monthly run: pro-rating for joiners and leavers, unpaid leave, days or hours entered for daily and hourly staff, two-thirds rule warnings; recalculate; approval by someone else numbers payslips and repays loans; mark paid. Journals to the ledger on approval and payment. Off-cycle payrolls for bonuses, arrears and final dues (leave not taken, notice pay, severance, loan recovery), with PAYE, NSSF, SHIF, the levy and NITA worked on the month's total so nothing is deducted or relieved twice |
| Returns | PAYE (P10), NSSF, SHIF, housing levy and net-pay (bank / M-Pesa) schedules as CSV, due dates, payroll register, P9 per employee per year |
| Leave | Kenyan leave types (annual accrues 1.75 days a month), working days excluding holidays, balances, approval by HR or line managers limited to their departments, carry-forward at year end |
| Self-service | `/hr/me`: own payslips, P9s, leave balances and applications. HR gives access from the employee page; someone who already signs in (a meter reader) keeps one login |

Events it raises: `hr.payroll.approved`, `hr.payroll.paid`, `hr.leave.approved`.

### Moving a company from farajasofterp

```bash
# .env.local: SOURCE_MONGODB_URI (farajasofterp, read only), SOURCE_COMPANY_ID if it holds several companies,
# SOURCE_FIELD_ENCRYPTION_KEY if ID/bank/M-Pesa numbers are encrypted, IMPORT_ORG_CODE (the organisation here)
npm run import:farajasofterp                              # dry run: reads, checks, reports; writes nothing
npm run import:farajasofterp -- --commit                  # writes; safe to repeat (matched on farajasofterp ids)
npm run import:farajasofterp -- --commit --with-logins    # also self-service logins with staff's old passwords
```

It brings departments, employees (KRA PIN, NSSF and SHA/NHIF numbers from their custom fields), basic salary and
fixed allowances, every approved pay run as payslips (so payslips, P9s and returns cover the old months), leave
types, leave applications and this year's balances (set to match farajasofterp exactly). Imported payrolls are
marked as history and never sent to the ledger. After writing, it works the last imported month again with this
engine and lists every employee whose net pay would differ – the parallel-run check before going live. The
report (a JSON file, holding staff names and pay; kept out of git) lists anything that needs a person: invalid
KRA PINs, daily or hourly staff, clashing employee numbers.

## Finance & Procurement module

FarajaSoft Accounting, moved in whole as `src/modules/finance` (server in `core/`, screens under `/finance`):
general ledger with maker-checker posting, receivables and payables, banking and M-Pesa (C2B, STK, B2C/B2B,
self-reconciling), budgets with spending control, fixed assets and depreciation, expense claims, requisitions →
RFQs → purchase orders → goods received with three-way matching, inventory and stores, VAT/WHT and KRA eTIMS,
multi-entity consolidation and FX, analytics, the management pack and its own approval engine.

- **One system.** Its collections live in the same database with a `finance_` prefix; its API is mounted at
  `/api/v1/finance` (`mount` in the module contract). People sign in to the platform only: finance builds its
  caller from the platform session (`core/bridge.ts`). The platform role in Finance picks the starting finance
  roles; extra roles, branch limits and approval limits are set under Finance → Setup → Users & roles. People are
  added under Settings → Users & roles, never in finance.
- **First use.** The first time someone opens Finance, it is set up for the organisation (same id): roles, the
  first entity and branch, a chart of accounts, tax codes and a July–June fiscal year.
- **The ledger.** Finance becomes the platform ledger (`ledger.ts`): water, HR and every other module post their
  journals straight into it, idempotently, as far as Settings → Ledger's mode allows (draft, submit or post).
  Organisations without finance still post to a separate FarajaSoft Accounting over its API.
- **Tests.** `npm run test:finance` runs finance's own suites stand-alone (`FINANCE_STANDALONE=true`: its own router
  and sign-in) on an in-memory replica set; `tests/finance-platform.e2e-spec.ts` covers it inside the platform.

## Running it

```bash
cp .env.example .env.local      # MONGODB_URI (replica set), JWT_SECRET, SEED_ADMIN_*
npm install
npm run db:seed                 # organisation, administrator, every module switched on with its starter data
npm run db:seed -- --demo       # plus each module's demo users and records
npm run dev                     # http://localhost:3100
```

Then Settings → Ledger (FarajaSoft Accounting address + `fsk_` API key), Settings → SMS, and in Water
settings: billing rules, M-Pesa paybill (register the two URLs shown with Safaricom) and ledger accounts.
The seeded water tariffs are **examples** – replace them with the approved WASREB tariff before billing.

## Checks

```bash
npm run typecheck && npm run lint
npm test            # unit: manifests, ledger, tariffs, consumption, NRW, M-Pesa, journals
npm run test:e2e    # every module and the platform, against an in-memory MongoDB replica set
npm run test:finance  # finance's own suites (moved in from FarajaSoft Accounting)
```

## Still to do

Port the other systems in as modules (procurement, CRM, accounting as the in-process finance module) and move
their existing data across. HR still to bring from farajasofterp: attendance and rosters with the Expo mobile
app (days and hours are typed in until then), recruitment, onboarding and offboarding, performance, training
and assets. The import does not bring per-month one-off components (bonuses entered for a
future month) or documents; re-enter those. Water gaps: GIS, SCADA/AMR, production
& water-quality logs, maintenance job cards, kiosks/bowsers, USSD, bank collection APIs, WASREB return formats,
and the reconnection fee is not yet posted to the ledger.
