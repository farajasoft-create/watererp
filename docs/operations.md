# Operations: backup, restore, scheduled jobs and recovery

## Backup

`npm run db:backup` writes the whole database (every module, uploaded documents included) to
`backups/gerp-YYYYMMDD-HHMM.jsonl.gz` and keeps the newest 14 (`BACKUP_KEEP`, `BACKUP_DIR` change this).
The file holds each collection's document count and index definitions, then every document in extended
JSON, so ids, amounts and dates come back exactly.

- Run it nightly from cron (Linux: `30 1 * * * cd /opt/gerp && npm run db:backup`) or Windows Task Scheduler.
- Copy the backups folder off the server every day (another site or encrypted cloud storage); keep monthly
  copies for a year and year-end copies for seven years.
- MongoDB replica-set members on separate hosts give a second, live copy; backups protect against mistakes
  and corruption the replicas would copy.

## Restore

- Into an empty database: set `MONGODB_URI` to it and run `npm run db:restore -- backups/<file>`.
- Over a damaged database: `npm run db:restore -- backups/<file> --replace` drops and reloads the
  collections the backup holds.

The restore rebuilds the indexes and refuses to finish if any collection's count differs from the backup.
Test it monthly: restore the latest backup into a scratch database, start the app against it, sign in,
and open a customer statement, a payslip and a trial balance. Record the test in the ICT log.

Recovery targets: data loss of at most one day (nightly backup; less with the replica set) and service back
within four hours (new server, restore, DNS).

## Scheduled jobs

Call these from the scheduler with the API key of a service user holding the managing role in each module (Settings → Developers):

| Job | Endpoint | When |
|---|---|---|
| Water ticket escalation and auto-close | `POST /api/v1/water/tickets/housekeeping` | every 15 minutes |
| ICT help desk escalation | `POST /api/v1/ict/helpdesk/housekeeping` | every 15 minutes |
| Internal audit reminders | `POST /api/v1/internalaudit/housekeeping` | daily |
| Data warehouse snapshot (every module's key figures for the day) | `POST /api/v1/warehouse/snapshot` | daily, late evening |
| SMS delivery | `POST /api/v1/sms/deliver` | every minute |
| BI scheduled reports | `POST /api/v1/bi/schedules/run` | hourly |
| Finance jobs (recurring journals, reminders) | `POST /api/v1/finance/cron/run` | hourly |

## Monitoring

- `/api/v1/health` reports the database connection; point the uptime monitor at it.
- Watch disk space on the database volume (alert at 80 %).
