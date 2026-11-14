# Data Protection Act, 2019: how gERP supports compliance

TACHWASCO is a data controller for customers', staff's, applicants', suppliers', tenants' and bidders'
personal data. This note maps the Act's duties to what the system does, and lists what remains an
organisational procedure.

| Duty (section) | In the system | Procedure for TACHWASCO |
|---|---|---|
| Lawful, fair, transparent processing (s.25) | Each portal says what is collected and why at the point of collection (jobs, MSME, tenders, customer portal). | Publish the privacy notice on the website and portals; register with the ODPC as controller and processor. |
| Purpose limitation and minimisation (s.25(c),(d)) | Forms collect only what each process needs; statutory numbers (KRA PIN, NSSF, SHA) only where the law requires them. | Review forms yearly. |
| Accuracy (s.25(e)) | Staff correct their own details through self-service change requests approved by HR; customers through the service desk. | |
| Storage limitation (s.25(g)) | Records carry their dates; unsuccessful applicants' profiles are archived; portal links expire. | Retention schedule: applicants 1 year after the vacancy closes; tender bids 7 years (PPADA); payroll and finance records 7 years (Tax Procedures Act); customer accounts 7 years after closure. Delete or anonymise at the end. |
| Security (s.41) | See `docs/security.md`: roles, two-step sign-in, encryption of secrets, audit trail, hashed links, HTTPS headers, rate limits, backups. | Annual penetration test; access reviews. |
| Right of access (s.26(b)) | Settings → Data protection searches every module by email, phone, ID number or KRA PIN and exports the records found as a file; each search and its reason are audited. | Answer within 7 days of a verified request. |
| Rectification and erasure (s.40) | Records can be corrected by their owners in each module; the search above finds everything that must change. | Erase or anonymise unless a law requires keeping the record (tax, PPADA); document the decision. |
| Objection to direct marketing (s.36) | SMS and email are sent only for service purposes (bills, notices, statuses). | Do not use customer data for marketing without consent. |
| Children's data (s.33) | Dependants' details in HR are visible only to HR and payroll roles. | |
| Data breach notification (s.43) | The audit trail and access logs show what was reached and by whom. | Notify the Data Commissioner within 72 hours and affected people without delay; keep a breach register. |
| Transfers outside Kenya (s.48) | The system and its database run on TACHWASCO's servers or a Kenyan data centre; SMS goes through a Kenyan gateway. | If a cloud region outside Kenya is ever chosen, document the safeguards first. |
| Data protection impact assessment (s.31) | | Carry out a DPIA before go-live for the customer portal, payroll and recruitment, and when processing changes. |
| Data protection officer (s.24) | The DPO is given the Administrator role or the audit permission to run subject searches. | Appoint and register the DPO. |
