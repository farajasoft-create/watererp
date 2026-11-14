# Data migration and change management plan

## 1. Data migration

### Scope and sources
| Data | Source | Tool in gERP | Checks before sign-off |
|---|---|---|---|
| Water customers, zones, tariffs, opening balances | Legacy billing export (CSV) | Water → Customers → Import from old system (dry run, then load; old-to-new account map) | Account count and total opening balance equal the legacy aged-debt report per zone |
| Meters and last readings | Legacy meter register | Meters screen / API (`POST /water/meters`, `/install`) | Meter count per zone; last reading per account |
| Staff, pay, statutory numbers, departments | FarajaSoft ERP / payroll export | `npm run import:farajasofterp` | Head count, gross and net pay of the last legacy payroll reproduced to the shilling |
| Chart of accounts, customers, suppliers, opening balances | Legacy accounts | Finance → Setup → Import (templates for each kind) | Trial balance at cut-over equals the audited closing balances |
| Fixed assets | Asset register | Finance → Assets import | Cost and accumulated depreciation per category |
| Documents | Shared drives | Documents upload (bulk by category) | Spot check of 5 % |

### Steps
1. **Assess** (2 weeks): get sample exports, map every field, list gaps and duplicates; agree owners.
2. **Cleanse** (3 weeks, by the data owners): duplicates merged, phone numbers in 07…/01… form, ID and
   KRA numbers checked, closed accounts flagged, tariffs and zones agreed.
3. **Trial loads** (2 rounds): load into a test copy; every import refuses a file with errors and lists
   them by row, so fix at source and repeat until clean; reconcile totals as in the table.
4. **Cut-over** (one weekend after a month-end): freeze legacy entry, final export, load, reconcile, and
   sign off by Finance, Commercial and HR heads. Keep the legacy system read-only for 12 months.
5. **Parallel run**: one billing cycle and one payroll run in both systems; differences explained before the
   legacy system is retired.

## 2. Change management

- **Sponsor and champions**: the Managing Director sponsors; one champion per department (billing, customer
  service, HR, finance, procurement, stores, ICT, internal audit) owns readiness.
- **Communication**: monthly memos through gERP's own Memos module from go-live; a briefing to staff and the
  union before training; customers told through bills, SMS and the portal about new paybill references
  and the self-service portal.
- **Training**: role-based sessions (meter readers on phones, cashiers, customer care, HR, payroll,
  accountants, storekeepers, procurement, auditors), with a sandbox copy and short task cards; train the
  trainers in ICT for new staff.
- **Support**: the ICT help desk in gERP takes issues from day one with response times by priority; daily
  stand-up for the first month; floor-walkers in each department in the first two weeks.
- **Measuring adoption**: BI dashboards on logins per module, tickets by category, bills issued on time and
  payroll on time; issues closed before acceptance.
- **Acceptance**: user acceptance tests per process, signed by the process owner, before go-live.
